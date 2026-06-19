import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CodeBuddy usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches quota with IDE access token and saved identity headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageCode: "TCACA_code_001_PqouKr6QWV",
                CycleCapacitySize: 100,
                CycleCapacityRemain: 80,
                CapacityUsed: 20,
              },
            ],
          },
        },
      },
    }));

    const usage = await getUsageForProvider({
      provider: "codebuddy",
      accessToken: "ide-access-token",
      providerSpecificData: {
        uid: "uid-1",
        enterpriseId: "enterprise-1",
      },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://www.codebuddy.ai/v2/billing/meter/get-user-resource");
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer ide-access-token");
    expect(proxyAwareFetch.mock.calls[0][1].headers["X-User-Id"]).toBe("uid-1");
    expect(proxyAwareFetch.mock.calls[0][1].headers["X-Enterprise-Id"]).toBe("enterprise-1");
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body).PackageCodes).toBeUndefined();
    expect(usage.authMode).toBe("oauth");
    expect(usage.quotas["Monthly Credits"]).toMatchObject({
      used: 20,
      total: 100,
      remaining: 80,
    });
  });

  it("reports chat key active instead of access-token missing for apiKey-only connections", async () => {
    const usage = await getUsageForProvider({
      provider: "codebuddy",
      apiKey: "cb-key",
      providerSpecificData: {
        authMode: "generated-api-key",
      },
    });

    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(usage.plan).toBe("CodeBuddy");
    expect(usage.message).toContain("chat key active");
    expect(usage.message).toContain("Upstream quota is unavailable");
    expect(usage.message).toContain("9router Usage");
    expect(usage.trackingMode).toBe("local-router");
    expect(usage.quotas).toEqual({});
  });

  it("does not replay quota with a saved cookie for generated-key connections", async () => {
    const usage = await getUsageForProvider({
      provider: "codebuddy",
      apiKey: "cb-key",
      providerSpecificData: {
        webCookie: "session=abc",
        authMode: "generated-api-key",
      },
    });

    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(usage.authMode).toBe("generated-api-key");
    expect(usage.trackingMode).toBe("local-router");
  });

  it("does not fall back to cookie when the IDE OAuth token is rejected", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, 401));
    const usage = await getUsageForProvider({
      provider: "codebuddy",
      accessToken: "rejected-token",
      apiKey: "cb-key",
      providerSpecificData: {
        uid: "uid-1",
        enterpriseId: "enterprise-1",
        webCookie: "session=expired",
        authMode: "generated-api-key",
      },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.message).toContain("IDE OAuth token was rejected (401)");
    expect(usage.message).toContain("9router Usage");
    expect(usage.authMode).toBe("oauth-rejected");
    expect(usage.trackingMode).toBe("local-router");
    expect(usage.quotas).toEqual({});
  });

  it("fetches CodeBuddy CN quota with OAuth token only and no cookies", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "OK",
        data: { Response: { Data: { TotalCount: 0, Accounts: [] } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "OK",
        data: {
          Response: {
            Data: {
              TotalCount: 1,
              Accounts: [{
                PackageCode: "TCACA_code_008_cfWoLwvjU4",
                CapacitySize: 500,
                CapacityRemain: 450,
                CapacityUsed: 50,
              }],
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "OK",
        data: {
          Response: {
            Data: {
              TotalCount: 1,
              Accounts: [{
                PackageCode: "TCACA_code_007_nzdH5h4Nl0",
                CapacitySize: 2000,
                CapacityRemain: 1800,
                CapacityUsed: 200,
              }],
            },
          },
        },
      }));

    const usage = await getUsageForProvider({
      provider: "codebuddy-cn",
      accessToken: "cn-access-token",
      providerSpecificData: {
        domain: "copilot.tencent.com",
        uid: "uid-cn",
        enterpriseId: "enterprise-cn",
      },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://www.codebuddy.cn/billing/meter/get-user-resource");
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers.Authorization).toBe("Bearer cn-access-token");
      expect(options.headers.Cookie).toBeUndefined();
      expect(options.headers.cookie).toBeUndefined();
      expect(options.headers["X-Domain"]).toBe("www.codebuddy.cn");
      expect(options.headers.Origin).toBe("https://www.codebuddy.cn");
      expect(options.headers.Referer).toBe("https://www.codebuddy.cn/profile/usage");
    }
    expect(JSON.parse(proxyAwareFetch.mock.calls[1][1].body).PackageCodes).toEqual(["TCACA_code_008_cfWoLwvjU4"]);
    expect(usage.authMode).toBe("oauth");
    expect(usage.quotas["Monthly Credits"]).toMatchObject({ used: 50, total: 500, remaining: 450 });
    expect(usage.quotas["Activity Credits"]).toMatchObject({ used: 200, total: 2000, remaining: 1800 });
  });
});
