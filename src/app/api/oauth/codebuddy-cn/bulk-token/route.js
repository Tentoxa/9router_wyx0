import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

export const dynamic = "force-dynamic";

const CODEBUDDY_CN_PROVIDER_ID = "codebuddy-cn";
const CODEBUDDY_CN_DOMAIN = "copilot.tencent.com";

async function fetchAccountInfo(accessToken, domain) {
  try {
    const response = await fetch(`https://${domain}/v2/plugin/accounts`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "X-Domain": domain,
      },
    });

    if (!response.ok) return { uid: null, email: null, nickname: null };

    const body = await response.json();
    const accounts = body?.data?.accounts || [];
    const account = accounts.find((a) => a.lastLogin) || accounts[0] || {};
    return {
      uid: account.uid || null,
      email: account.email || account.nickname || null,
      nickname: account.nickname || null,
      enterpriseId: account.enterpriseId || null,
    };
  } catch {
    return { uid: null, email: null, nickname: null };
  }
}

function parseTokenLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":");
  if (!parts[0] || !parts[0].includes(".")) {
    throw new Error("Invalid access token format - not a valid JWT");
  }

  if (parts.length === 1) {
    return {
      accessToken: parts[0],
      format: "access-only",
    };
  }

  if (parts.length === 2) {
    if (!parts[1] || !parts[1].includes(".")) {
      throw new Error("Invalid refresh token format - not a valid JWT");
    }
    return {
      accessToken: parts[0],
      refreshToken: parts[1],
      format: "with-refresh",
    };
  }

  throw new Error("Invalid token format - expected accessToken or accessToken:refreshToken");
}

export async function POST(request) {
  try {
    const body = await request.json();
    const rawTokens = body?.tokens;

    if (!rawTokens || (typeof rawTokens !== "string" && !Array.isArray(rawTokens))) {
      return NextResponse.json(
        { error: "Provide tokens as a string (one per line) or array" },
        { status: 400 }
      );
    }

    const tokenList = Array.isArray(rawTokens)
      ? rawTokens.map((t) => String(t || "").trim()).filter(Boolean)
      : String(rawTokens)
          .split(/[\r\n]+/)
          .map((t) => t.trim())
          .filter(Boolean);

    if (tokenList.length === 0) {
      return NextResponse.json(
        { error: "At least one token is required" },
        { status: 400 }
      );
    }

    const results = [];
    const formatCounts = {
      "access-only": 0,
      "with-refresh": 0,
    };

    for (const tokenLine of tokenList) {
      try {
        const parsed = parseTokenLine(tokenLine);
        if (!parsed) {
          results.push({
            token: "(empty line)",
            status: "failed",
            error: "Empty or invalid token line",
          });
          continue;
        }

        const { accessToken, refreshToken, format } = parsed;
        formatCounts[format] += 1;

        const info = await fetchAccountInfo(accessToken, CODEBUDDY_CN_DOMAIN);
        const email = info.email || `token-${accessToken.substring(0, 8)}...`;

        const providerSpecificData = {
          domain: CODEBUDDY_CN_DOMAIN,
          loginEmail: email,
          automation: "bulk-token-import",
          authMode: "oauth-only",
        };

        if (info.uid) providerSpecificData.uid = info.uid;
        if (info.enterpriseId) providerSpecificData.enterpriseId = info.enterpriseId;

        const connectionData = {
          provider: CODEBUDDY_CN_PROVIDER_ID,
          authType: "oauth",
          accessToken,
          email,
          providerSpecificData,
          expiresIn: 86400,
          testStatus: info.uid ? "active" : "unknown",
        };

        if (refreshToken) {
          connectionData.refreshToken = refreshToken;
        }

        const connection = await createProviderConnection(connectionData);

        results.push({
          email,
          status: "success",
          connectionId: connection.id,
          uid: info.uid,
          format,
          hasRefreshToken: !!refreshToken,
        });
      } catch (error) {
        results.push({
          token: tokenLine.substring(0, 12) + "...",
          status: "failed",
          error: error.message || "Failed to import token",
        });
      }
    }

    const successCount = results.filter((r) => r.status === "success").length;
    const failedCount = results.filter((r) => r.status === "failed").length;

    return NextResponse.json({
      success: true,
      imported: successCount,
      failed: failedCount,
      total: tokenList.length,
      formatCounts,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to import tokens" },
      { status: 500 }
    );
  }
}
