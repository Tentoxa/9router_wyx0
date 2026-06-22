import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// ─── Connection Pool Configuration ─────────────────────────────────────────
// Create a global undici Agent with connection pool limits to prevent socket exhaustion
let globalDispatcher = null;

async function getGlobalDispatcher() {
  if (!globalDispatcher) {
    const { Agent } = await import("undici");
    globalDispatcher = new Agent({
      // Connection pool limits - prevents socket exhaustion
      connect: {
        timeout: 60000, // 60s connection timeout
        // TCP-level optimizations (matches CodeBuddy CLI)
        keepAlive: true,
        keepAliveInitialDelay: 30000, // 30s TCP keepalive (OS-level) — probes before upstream idle kill
        noDelay: true, // Disable Nagle's algorithm for immediate data transmission
      },
      // Max concurrent connections per host
      connections: 128,
      // CRITICAL FIX: keepAliveTimeout must be WELL BELOW the upstream's idle kill timeout.
      // copilot.tencent.com kills idle connections at ~100-109s. If our keepAliveMaxTimeout
      // is higher, the upstream RST arrives while the socket is still in our pool, causing
      // an unhandled ECONNRESET that zombifies the process.
      // 4s base timeout with 30s max — undici picks a random value in [keepAliveTimeout, keepAliveMaxTimeout]
      // so worst case is 30s, well below the 100s upstream kill.
      keepAliveTimeout: 4000, // 4 seconds (was 2s — slightly higher to avoid churning for active pools)
      keepAliveMaxTimeout: 30000, // 30 seconds max (was 60s — MUST be below upstream's ~100s idle kill)
      // Disable pipelining for now (can be enabled later if needed)
      pipelining: 0,
      // FIX: Increase body and headers timeout for large requests (anthropic-compatible with 1.45MB bodies)
      bodyTimeout: 300000, // 5 minutes (was default 30s)
      headersTimeout: 300000, // 5 minutes (was default 30s)
    });

    // FIX: Listen for errors on the Agent itself.
    // When a pooled (idle) socket receives a TCP RST from the upstream, undici emits an
    // 'error' event on the Agent. Without a listener, this becomes an uncaughtException.
    // This is the ROOT CAUSE of the zombie process bug: idle socket RST → unhandled error → process hangs.
    globalDispatcher.on("error", (err) => {
      const code = err?.code || err?.cause?.code || "?";
      const msg = err?.message || String(err);
      // Idle socket resets are expected — log and swallow. The pool will recover on its own.
      if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE" || msg.includes("aborted")) {
        dbg("PROXY", `idle socket error (expected, swallowed): code=${code} | msg=${msg}`);
        return;
      }
      // Non-transient errors — log prominently but don't crash (the safety net in start-standalone handles that)
      console.warn(`[ProxyFetch] Agent error: code=${code} | msg=${msg}`);
    });

    dbg("PROXY", `global dispatcher created with keep-alive ENABLED (4s base, 30s max)`);
  }
  return globalDispatcher;
}

// Refresh global dispatcher periodically to prevent connection state corruption
// Changed from 30s to 10 minutes - aggressive refresh caused race conditions and performance issues
let globalDispatcherAge = Date.now();
const DISPATCHER_REFRESH_MS = 10 * 60 * 1000; // 10 minutes (was 30s)

// Lock to prevent race conditions during dispatcher refresh
let refreshPromise = null;

/**
 * Force refresh dispatcher on connection errors
 */
function forceRefreshDispatcher(error) {
  const errorCode = error.code || error.errno;
  const isConnectionError = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(errorCode);

  if (isConnectionError) {
    dbg("PROXY", `force refresh due to ${errorCode} error`);
    globalDispatcherAge = 0; // Force refresh on next request
  }
}

async function getFreshGlobalDispatcher() {
  // If refresh is already in progress, wait for it
  if (refreshPromise) {
    return refreshPromise;
  }

  const now = Date.now();
  if (now - globalDispatcherAge <= DISPATCHER_REFRESH_MS) {
    return globalDispatcher || getGlobalDispatcher();
  }

  // Start refresh with lock
  refreshPromise = (async () => {
    const oldDispatcher = globalDispatcher;
    globalDispatcher = null;
    globalDispatcherAge = Date.now();

    const newDispatcher = await getGlobalDispatcher();

    if (oldDispatcher) {
      try {
        await oldDispatcher.close();
        dbg("PROXY", `global dispatcher refreshed (closed after ${Math.round((now - globalDispatcherAge) / 1000)}s)`);
      } catch (err) {
        console.warn(`[ProxyFetch] error closing old global dispatcher: ${err.message}`);
      }
    }

    return newDispatcher;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const DNS_CACHE_MAX_SIZE = 1000; // P1 FIX: Prevent unbounded growth
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  // Clean up expired entries periodically
  if (DNS_CACHE.size > 100) {
    const now = Date.now();
    for (const [key, value] of DNS_CACHE.entries()) {
      if (now >= value.expiry) {
        DNS_CACHE.delete(key);
      }
    }
  }

  // P1 FIX: Evict oldest entries if cache is full
  if (DNS_CACHE.size >= DNS_CACHE_MAX_SIZE) {
    const oldestKey = DNS_CACHE.keys().next().value;
    DNS_CACHE.delete(oldestKey);
    dbg("DNS", `evicted oldest entry (cache full: ${DNS_CACHE.size}/${DNS_CACHE_MAX_SIZE})`);
  }

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      const oldestKey = proxyDispatchers.keys().next().value;
      const oldDispatcher = proxyDispatchers.get(oldestKey);
      proxyDispatchers.delete(oldestKey);
      dispatcherCreationTime.delete(oldestKey); // P0 FIX: Clean up creation time map

      // CRITICAL FIX: Close the dispatcher to release connections
      try {
        await oldDispatcher.close();
        dbg("PROXY", `dispatcher evicted and closed | proxy=${oldestKey}`);
      } catch (err) {
        console.warn(`[ProxyFetch] failed to close evicted dispatcher: ${err.message}`);
      }
    }
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent({
      uri: normalized,
      // Limit TLS session cache to prevent unbounded growth
      maxCachedSessions: MEMORY_CONFIG.tlsSessionMaxAge ? 10 : 100,
      // FIX: Same keep-alive timeout fix as the global Agent — prevent idle socket RST
      keepAliveTimeout: 4000,
      keepAliveMaxTimeout: 30000,
    });
    // FIX: Swallow idle socket errors on proxy dispatchers too
    dispatcher.on("error", (err) => {
      const code = err?.code || err?.cause?.code || "?";
      const msg = err?.message || String(err);
      if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE" || msg.includes("aborted")) {
        dbg("PROXY", `proxy idle socket error (expected, swallowed): code=${code} | msg=${msg}`);
        return;
      }
      console.warn(`[ProxyFetch] ProxyAgent error: code=${code} | msg=${msg}`);
    });
    proxyDispatchers.set(normalized, dispatcher);
    dbg("PROXY", `dispatcher created | proxy=${normalized} | pool_size=${proxyDispatchers.size}`);
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let req = null;
    let abortListener = null;

    // Socket cleanup helper - ensures no socket leaks
    const cleanup = () => {
      // Remove abort listener to prevent memory leak
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
        abortListener = null;
      }

      if (req) {
        try {
          req.destroy();
        } catch (err) {
          dbg("SOCKET", `failed to destroy request: ${err.message}`);
        }
        req = null;
      }
      if (socket && !socket.destroyed) {
        try {
          socket.destroy();
        } catch (err) {
          dbg("SOCKET", `failed to destroy socket: ${err.message}`);
        }
      }
    };

    socket.connect(HTTPS_PORT, realIP, () => {
      // TCP-level optimizations (matches CodeBuddy CLI)
      socket.setKeepAlive(true, 60000); // 60s TCP keepalive (OS-level)
      socket.setNoDelay(true); // Disable Nagle's algorithm for immediate data transmission

      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        // Don't cleanup here - socket stays open for response streaming
        // Cleanup happens when response body is fully consumed or on error
        resolve(response);
      });

      req.on("error", (err) => {
        cleanup();
        reject(err);
      });

      req.on("close", () => {
        // Socket closed after response body consumed
        cleanup();
      });

      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // Timeout handling
    if (options.signal?.aborted) {
      cleanup();
      reject(new Error("Request aborted"));
      return;
    }

    if (options.signal) {
      abortListener = () => {
        cleanup();
        reject(new Error("Request aborted"));
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch(url, { ...options, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    const dispatcherStart = Date.now();
    let dispatcher;
    try {
      dispatcher = await getDispatcher(proxyUrl);
      dbg("PROXY", `dispatcher created in ${Date.now() - dispatcherStart}ms | proxy=${proxyUrl} | target=${targetUrl}`);
    } catch (dispatcherError) {
      console.error(`[ProxyFetch] ❌ dispatcher creation failed after ${Date.now() - dispatcherStart}ms | proxy=${proxyUrl}`, {
        error: dispatcherError.message,
        stack: dispatcherError.stack?.split('\n').slice(0, 3).join(' | ')
      });
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy dispatcher creation failed: ${dispatcherError.message}`);
      }
      console.warn(`[ProxyFetch] falling back to direct (no proxy)`);
      return originalFetch(url, options);
    }

    const fetchStart = Date.now();
    const requestBodySize = options?.body ? (typeof options.body === 'string' ? options.body.length : options.body.byteLength || options.body.length || '?') : 0;
    dbg("PROXY", `fetch start | proxy=${proxyUrl} | target=${targetUrl} | body=${requestBodySize}B | method=${options?.method || 'GET'}`);

    try {
      const response = await originalFetch(url, { ...options, dispatcher });
      const fetchDuration = Date.now() - fetchStart;
      dbg("PROXY", `fetch success | proxy=${proxyUrl} | target=${targetUrl} | status=${response.status} | duration=${fetchDuration}ms | content-type=${response.headers?.get?.('content-type') || '?'}`);
      return response;
    } catch (proxyError) {
      const fetchDuration = Date.now() - fetchStart;
      const isTimeout = proxyError.name === 'AbortError' && options?.signal?.aborted;
      const errorType = isTimeout ? 'TIMEOUT' :
                       proxyError.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' :
                       proxyError.code === 'ENOTFOUND' ? 'DNS_FAILED' :
                       proxyError.code === 'ETIMEDOUT' ? 'TCP_TIMEOUT' :
                       proxyError.code === 'ECONNRESET' ? 'CONNECTION_RESET' :
                       'UNKNOWN';

      console.error(`[ProxyFetch] ❌ fetch failed | type=${errorType} | proxy=${proxyUrl} | target=${targetUrl} | duration=${fetchDuration}ms`, {
        errorName: proxyError.name,
        errorMessage: proxyError.message,
        errorCode: proxyError.code,
        errno: proxyError.errno,
        syscall: proxyError.syscall,
        address: proxyError.address,
        port: proxyError.port,
        hostname: proxyError.hostname,
        signalAborted: options?.signal?.aborted,
        signalReason: options?.signal?.reason?.message
      });

      // Force dispatcher refresh on connection errors
      forceRefreshDispatcher(proxyError);

      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] falling back to direct (no proxy) after ${fetchDuration}ms`);
      return originalFetch(url, options);
    }
  }

  // got-scraping disabled — use native fetch with global dispatcher
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  const fetchStart = Date.now();
  const requestBodySize = options?.body ? (typeof options.body === 'string' ? options.body.length : options.body.byteLength || options.body.length || '?') : 0;
  dbg("DIRECT", `fetch start | target=${targetUrl} | body=${requestBodySize}B | method=${options?.method || 'GET'}`);

  try {
    // Use global dispatcher with connection pool limits to prevent socket exhaustion
    const dispatcher = await getFreshGlobalDispatcher();
    const response = await originalFetch(url, { ...options, dispatcher });
    const fetchDuration = Date.now() - fetchStart;
    dbg("DIRECT", `fetch success | target=${targetUrl} | status=${response.status} | duration=${fetchDuration}ms`);
    return response;
  } catch (directError) {
    const fetchDuration = Date.now() - fetchStart;
    const isTimeout = directError.name === 'AbortError' && options?.signal?.aborted;
    const errorType = isTimeout ? 'TIMEOUT' :
                     directError.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' :
                     directError.code === 'ENOTFOUND' ? 'DNS_FAILED' :
                     directError.code === 'ETIMEDOUT' ? 'TCP_TIMEOUT' :
                     directError.code === 'ECONNRESET' ? 'CONNECTION_RESET' :
                     'UNKNOWN';

    console.error(`[ProxyFetch] ❌ direct fetch failed | type=${errorType} | target=${targetUrl} | duration=${fetchDuration}ms`, {
      errorName: directError.name,
      errorMessage: directError.message,
      errorCode: directError.code,
      errno: directError.errno,
      syscall: directError.syscall,
      signalAborted: options?.signal?.aborted,
      signalReason: options?.signal?.reason?.message
    });

    // Force dispatcher refresh on connection errors
    forceRefreshDispatcher(directError);

    throw directError;
  }
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

// ─── Periodic Cleanup & Graceful Shutdown ──────────────────────────────────

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DISPATCHER_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const dispatcherCreationTime = new Map();

// Track dispatcher creation time
const originalGetDispatcher = getDispatcher;
getDispatcher = async function(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!dispatcherCreationTime.has(normalized)) {
    dispatcherCreationTime.set(normalized, Date.now());
  }
  return originalGetDispatcher(proxyUrl);
};

// Periodic cleanup of expired DNS entries and old dispatchers
let lastCleanupTime = Date.now();

function periodicCleanup() {
  const now = Date.now();

  // Only run cleanup every 5 minutes
  if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupTime = now;

  // Clean expired DNS entries
  const expiredDns = [];
  for (const [hostname, entry] of DNS_CACHE.entries()) {
    if (entry.expiry && now > entry.expiry) {
      DNS_CACHE.delete(hostname);
      expiredDns.push(hostname);
    }
  }

  if (expiredDns.length > 0) {
    dbg("CLEANUP", `removed ${expiredDns.length} expired DNS entries`);
  }

  // Clean old dispatchers (older than 30 minutes)
  const oldDispatchers = [];
  for (const [url, dispatcher] of proxyDispatchers.entries()) {
    const creationTime = dispatcherCreationTime.get(url) || 0;
    if (now - creationTime > DISPATCHER_MAX_AGE_MS) {
      oldDispatchers.push({ url, dispatcher });
    }
  }

  if (oldDispatchers.length > 0) {
    oldDispatchers.forEach(({ url, dispatcher }) => {
      proxyDispatchers.delete(url);
      dispatcherCreationTime.delete(url);
      dispatcher.close().catch(err => {
        console.warn(`[ProxyFetch] error closing old dispatcher: ${err.message}`);
      });
    });
    dbg("CLEANUP", `removed ${oldDispatchers.length} old dispatchers`);
  }
}

// Run periodic cleanup with unref() to allow process to exit
const cleanupInterval = setInterval(periodicCleanup, CLEANUP_INTERVAL_MS);
cleanupInterval.unref(); // Don't keep process alive just for cleanup

// Graceful shutdown handler
export async function closeAllDispatchers() {
  const dispatchers = Array.from(proxyDispatchers.entries());
  proxyDispatchers.clear();
  DNS_CACHE.clear();
  dispatcherCreationTime.clear();

  await Promise.allSettled(
    dispatchers.map(async ([url, dispatcher]) => {
      try {
        await dispatcher.close();
        dbg("PROXY", `closed dispatcher | proxy=${url}`);
      } catch (err) {
        console.warn(`[ProxyFetch] error closing dispatcher: ${err.message}`);
      }
    })
  );

  dbg("PROXY", `closed ${dispatchers.length} dispatchers and cleared caches`);
}

let isShuttingDown = false;

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  dbg("PROXY", "starting graceful shutdown");
  await closeAllDispatchers();
  dbg("PROXY", "graceful shutdown complete");
}

// Register shutdown handlers
process.once('SIGTERM', gracefulShutdown);
process.once('SIGINT', gracefulShutdown);

export default patchedFetch;
