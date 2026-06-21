/**
 * Content Redaction Engine
 *
 * In-memory config store + redaction logic for scrubbing sensitive
 * words/phrases from error messages and LLM response content before
 * they reach the end-user client.
 *
 * Scope:
 *   - "errors"    → applied to error messages sent to the API client
 *   - "responses" → applied to LLM response content (streaming + non-streaming)
 *   - "both"      → applies to both errors and responses
 */

// ── In-memory config ──────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  rules: [],
});

let config = { enabled: false, rules: [] };

// Compiled rule cache — rebuilt whenever config changes
// Each entry: { id, regex, replacement, scope, enabled }
let compiledRules = [];

// ── Regex helpers ─────────────────────────────────────────────────

/**
 * Escape regex special characters in a plain-text pattern.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic ReDoS guard.
 * Rejects patterns that are likely to cause catastrophic backtracking.
 * Returns true if the pattern is considered safe to compile.
 */
function isSafePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (pattern.length > 500) return false;

  // Count nested quantifiers — deeply nested quantifiers are a ReDoS risk
  let depth = 0;
  let maxDepth = 0;
  for (const ch of pattern) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth > maxDepth) maxDepth = depth;
  }

  // Reject if more than 3 levels of nesting combined with many quantifiers
  const quantifierCount = (pattern.match(/[+*?{]/g) || []).length;
  if (maxDepth > 3 && quantifierCount > 10) return false;

  // Reject obvious catastrophic patterns like (a+)+ or (a*)*
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return false;

  return true;
}

/**
 * Compile a single rule into a cached entry.
 * Returns null if the rule is invalid or unsafe.
 */
function compileRule(rule) {
  if (!rule || !rule.pattern) return null;

  const flags = "g" + (rule.caseSensitive ? "" : "i");
  const source = rule.isRegex
    ? rule.pattern
    : escapeRegex(rule.pattern);

  if (rule.isRegex && !isSafePattern(rule.pattern)) {
    console.warn(`[ContentRedaction] ReDoS guard rejected pattern for rule "${rule.name}": ${rule.pattern}`);
    return null;
  }

  let regex;
  try {
    regex = new RegExp(source, flags);
  } catch (err) {
    console.warn(`[ContentRedaction] Invalid regex for rule "${rule.name}": ${err.message}`);
    return null;
  }

  return {
    id: rule.id,
    regex,
    replacement: rule.replacement ?? "[REDACTED]",
    scope: rule.scope || "both",
    enabled: rule.enabled !== false,
  };
}

/**
 * Recompile all rules into the cache.
 */
function recompile() {
  compiledRules = (config.rules || [])
    .map(compileRule)
    .filter(Boolean);
}

// ── Public API: config management ─────────────────────────────────

/**
 * Get a copy of the current redaction config.
 */
export function getRedactionConfig() {
  return JSON.parse(JSON.stringify(config));
}

/**
 * Replace the entire redaction config.
 * @param {{ enabled: boolean, rules: Array }} newConfig
 */
export function setRedactionConfig(newConfig) {
  config = {
    enabled: !!(newConfig && newConfig.enabled),
    rules: Array.isArray(newConfig?.rules) ? newConfig.rules : [],
  };
  recompile();
}

/**
 * Reset to disabled/empty state.
 */
export function clearRedactionConfig() {
  config = { enabled: false, rules: [] };
  compiledRules = [];
}

/**
 * Load redaction config from the database settings.
 * Called once at server startup; subsequent updates go through setRedactionConfig.
 */
export async function initRedactionFromDb() {
  try {
    const { getSettings } = await import("@/lib/localDb.js");
    const settings = await getSettings();
    setRedactionConfig(settings.contentRedaction || { enabled: false, rules: [] });
  } catch (err) {
    console.warn("[ContentRedaction] Failed to init from DB:", err.message);
  }
}

// ── Public API: redaction logic ───────────────────────────────────

/**
 * Apply all enabled, scope-matching rules to a text string.
 * @param {string} text - Input text
 * @param {"errors"|"responses"} scope - Which scope to apply
 * @returns {string} Redacted text
 */
export function redactText(text, scope) {
  if (!config.enabled || typeof text !== "string" || text.length === 0) {
    return text;
  }
  let result = text;
  for (const rule of compiledRules) {
    if (!rule.enabled) continue;
    if (rule.scope !== scope && rule.scope !== "both") continue;
    // Reset lastIndex for reused global regex
    rule.regex.lastIndex = 0;
    result = result.replace(rule.regex, rule.replacement);
  }
  return result;
}

/**
 * Deep-walk an object and apply redaction to all string values.
 * Returns a new object (does not mutate the original).
 * @param {*} obj - Any value (object, array, primitive)
 * @param {"errors"|"responses"} scope
 * @returns {*} Same shape with string values redacted
 */
export function redactObject(obj, scope) {
  if (!config.enabled) return obj;

  if (typeof obj === "string") {
    return redactText(obj, scope);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, scope));
  }

  if (obj && typeof obj === "object") {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[key] = redactObject(obj[key], scope);
    }
    return result;
  }

  return obj;
}

/**
 * Create a TransformStream that redacts content in SSE chunks.
 * Parses `data: {...}` JSON lines, redacts all string values, and re-serializes.
 * Non-data lines (comments, event tags, blank lines) are passed through unchanged.
 *
 * Returns null if redaction is disabled (caller should skip piping).
 *
 * @param {"errors"|"responses"} scope
 * @returns {TransformStream|null}
 */
export function createRedactionTransformStream(scope) {
  if (!config.enabled) return null;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Split into complete lines; keep last partial line in buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      const output = [];
      for (const line of lines) {
        const trimmed = line.trim();

        // Redact JSON data lines
        if (trimmed.startsWith("data:")) {
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            output.push(line + "\n");
            continue;
          }
          try {
            const parsed = JSON.parse(payload);
            const redacted = redactObject(parsed, scope);
            output.push("data: " + JSON.stringify(redacted) + "\n");
          } catch {
            // Not valid JSON — pass through with text redaction applied
            output.push("data: " + redactText(payload, scope) + "\n");
          }
        } else {
          // Pass through event tags, comments, blank lines
          output.push(line + "\n");
        }
      }

      controller.enqueue(encoder.encode(output.join("")));
    },

    flush(controller) {
      if (buffer) {
        // Process any remaining buffered text
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:")) {
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            controller.enqueue(encoder.encode(buffer + "\n"));
          } else {
            try {
              const parsed = JSON.parse(payload);
              const redacted = redactObject(parsed, scope);
              controller.enqueue(encoder.encode("data: " + JSON.stringify(redacted) + "\n"));
            } catch {
              controller.enqueue(encoder.encode("data: " + redactText(payload, scope) + "\n"));
            }
          }
        } else {
          controller.enqueue(encoder.encode(buffer + "\n"));
        }
      }
    },
  });
}
