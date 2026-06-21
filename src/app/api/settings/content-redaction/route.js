import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { setRedactionConfig } from "open-sse/services/contentRedaction.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

/**
 * Validate a redaction config object.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateConfig(config) {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "Config must be an object" };
  }
  if (typeof config.enabled !== "boolean") {
    return { valid: false, error: "enabled must be a boolean" };
  }
  if (!Array.isArray(config.rules)) {
    return { valid: false, error: "rules must be an array" };
  }

  const validScopes = ["errors", "responses", "both"];
  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];
    const prefix = `Rule ${i + 1}`;

    if (!rule || typeof rule !== "object") {
      return { valid: false, error: `${prefix}: must be an object` };
    }
    if (typeof rule.id !== "string" || !rule.id) {
      return { valid: false, error: `${prefix}: id must be a non-empty string` };
    }
    if (typeof rule.name !== "string" || !rule.name.trim()) {
      return { valid: false, error: `${prefix}: name must be a non-empty string` };
    }
    if (typeof rule.pattern !== "string" || !rule.pattern) {
      return { valid: false, error: `${prefix}: pattern must be a non-empty string` };
    }
    if (typeof rule.isRegex !== "boolean") {
      return { valid: false, error: `${prefix}: isRegex must be a boolean` };
    }
    if (typeof rule.replacement !== "string") {
      return { valid: false, error: `${prefix}: replacement must be a string` };
    }
    if (!validScopes.includes(rule.scope)) {
      return { valid: false, error: `${prefix}: scope must be one of: ${validScopes.join(", ")}` };
    }
    if (typeof rule.caseSensitive !== "boolean") {
      return { valid: false, error: `${prefix}: caseSensitive must be a boolean` };
    }
    if (typeof rule.enabled !== "boolean") {
      return { valid: false, error: `${prefix}: enabled must be a boolean` };
    }

    // Validate regex compilation
    if (rule.isRegex) {
      try {
        new RegExp(rule.pattern, "g" + (rule.caseSensitive ? "" : "i"));
      } catch (err) {
        return { valid: false, error: `${prefix}: invalid regex — ${err.message}` };
      }
    }
  }

  return { valid: true };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const config = settings.contentRedaction || { enabled: false, rules: [] };
    return NextResponse.json(config, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting content redaction config:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const config = await request.json();

    const validation = validateConfig(config);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const settings = await updateSettings({ contentRedaction: config });
    setRedactionConfig(settings.contentRedaction);

    return NextResponse.json(settings.contentRedaction, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating content redaction config:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
