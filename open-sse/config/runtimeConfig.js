// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
  tlsSessionMaxAge: 30 * 60 * 1000, // 30 Minuten - TLS Session Cache TTL
};

// Stream stall timeout: abort if no chunk received within this duration
// Official CodeBuddy CLI uses 1,200,000ms (20 min) for extended reasoning
// Claude Opus 4.7 with forceAdaptiveThinking can take 4-5+ minutes during thinking phase
// Server sends 30s heartbeats to keep connection alive, but no content chunks
export const STREAM_STALL_TIMEOUT_MS = 1200 * 1000; // 20 minutes (matches official CLI)

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
// CodeBuddy CLI uses 300s (5 min) for STREAM_SAFE_TIMEOUT_MS
// We use 300s as default to match upstream behavior
export const FETCH_CONNECT_TIMEOUT_MS = 300 * 1000;

// Provider-specific timeout overrides
// CodeBuddy CLI uses STREAM_SAFE_TIMEOUT_MS = 300s, but production logs show
// extended reasoning requests need 4-5+ minutes for first token (TTFT)
// Increased to 600s (10 min) to prevent cascading queue buildup
export const PROVIDER_TIMEOUTS = {
  codebuddy: 600 * 1000, // 10 minutes (extended reasoning needs 4-5 min TTFT)
  anthropic: 300 * 1000, // 5 minutes (large context windows)
  default: 120 * 1000, // 2 minutes for other providers
};

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
