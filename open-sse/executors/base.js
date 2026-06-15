import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS, PROVIDER_TIMEOUTS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { withConcurrencyLimit } from "../utils/requestQueue.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  // Override in subclass for providers that need encoded/binary request bodies.
  prepareRequestBody(transformedBody, headers) {
    return JSON.stringify(transformedBody);
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // Apply concurrency limiting for CodeBuddy to prevent server overload
    // CodeBuddy server queues/drops requests when too many hit it simultaneously
    const isCodeBuddy = this.provider?.toLowerCase().includes('codebuddy');
    const maxConcurrent = isCodeBuddy ? 10 : null;

    if (maxConcurrent) {
      return withConcurrencyLimit(this.provider, () => this._executeInternal({ model, body, stream, credentials, signal, log, proxyOptions }), maxConcurrent);
    }

    return this._executeInternal({ model, body, stream, credentials, signal, log, proxyOptions });
  }

  async _executeInternal({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // Respects retry-after and retry-after-ms headers like official CodeBuddy CLI
    // Falls back to exponential backoff with jitter if no retry-after headers present
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      retryAttemptsByUrl[urlIndex]++;

      // Priority 1: retry-after-ms header (milliseconds)
      let retryDelayMs = null;
      if (response?.headers) {
        const retryAfterMs = response.headers.get("retry-after-ms");
        const retryAfter = response.headers.get("retry-after");

        if (retryAfterMs && !isNaN(parseFloat(retryAfterMs))) {
          retryDelayMs = parseFloat(retryAfterMs);
          dbg("RETRY", `using retry-after-ms: ${retryDelayMs}ms`);
        } else if (retryAfter) {
          const parsed = parseFloat(retryAfter);
          if (!isNaN(parsed)) {
            retryDelayMs = parsed * 1000; // Convert seconds to ms
            dbg("RETRY", `using retry-after: ${retryDelayMs}ms`);
          }
        }
      }

      // Priority 2: Exponential backoff with jitter (official CodeBuddy CLI formula)
      // Formula: base * 2^(attempt-1) * jitter, capped at maxDelay
      if (retryDelayMs === null) {
        const base = 500; // 500ms base
        const maxDelay = 8000; // 8 seconds max
        const attempt = retryAttemptsByUrl[urlIndex];

        // Exponential backoff: 500ms, 1s, 2s, 4s, 8s
        const exponentialDelay = base * Math.pow(2, attempt - 1);

        // Apply jitter: 75-100% of calculated delay
        const jitter = 0.75 + Math.random() * 0.25;
        retryDelayMs = Math.min(exponentialDelay * jitter, maxDelay);

        dbg("RETRY", `using exponential backoff: ${retryDelayMs.toFixed(0)}ms (attempt ${attempt}, jitter ${(jitter * 100).toFixed(0)}%)`);
      }

      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${retryDelayMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout
      // Use provider-specific timeout if available, otherwise fall back to config or default
      const connectCtrl = new AbortController();
      const providerKey = this.provider.toLowerCase();
      const timeoutMs = this.config?.timeoutMs || PROVIDER_TIMEOUTS[providerKey] || PROVIDER_TIMEOUTS.default || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => {
        console.warn(`[CONNECT_TIMEOUT] ⏱️ aborting after ${timeoutMs}ms | provider=${this.provider} | url=${url} | urlIndex=${urlIndex}/${fallbackCount}`);
        connectCtrl.abort(new Error("fetch connect timeout"));
      }, timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      // Define fetchT0 and targetHost outside try block so they're available in catch
      const fetchT0 = Date.now();
      let targetHost;
      try {
        targetHost = new URL(url).hostname;
      } catch {
        targetHost = 'unknown';
      }
      const proxyEnabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
      const proxyUrl = proxyEnabled ? (proxyOptions?.url || proxyOptions?.connectionProxyUrl || 'env') : 'none';

      try {
        const requestBody = this.prepareRequestBody(transformedBody, headers);
        const requestBodySize = typeof requestBody === "string"
          ? requestBody.length
          : requestBody?.byteLength ?? requestBody?.length ?? "?";

        console.log(`[FETCH] 🚀 start | provider=${this.provider.toUpperCase()} | model=${model || '?'} | url=${url}`, {
          host: targetHost,
          body: `${requestBodySize}B`,
          connectTimeout: `${timeoutMs}ms`,
          urlIndex: `${urlIndex}/${fallbackCount}`,
          retryAttempt: retryAttemptsByUrl[urlIndex] || 0,
          proxy: proxyEnabled ? proxyUrl : 'disabled',
          signalAborted: signal?.aborted || false
        });

        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${requestBodySize}B | connectTimeout=${timeoutMs}ms`);

        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: requestBody,
          signal: mergedSignal
        }, proxyOptions);

        clearTimeout(connectTimer);
        const ttft = Date.now() - fetchT0;
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";

        console.log(`[FETCH] ✅ success | provider=${this.provider.toUpperCase()} | status=${response.status}`, {
          ttft: `${ttft}ms`,
          contentType: ct,
          contentLength: cl,
          host: targetHost,
          urlIndex: `${urlIndex}/${fallbackCount}`
        });

        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${ttft}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        const fetchDuration = Date.now() - fetchT0;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";

        // Detailed error logging for connect timeouts
        if (isConnectTimeout) {
          console.error(`[CONNECT_TIMEOUT] ❌ timeout | provider=${this.provider.toUpperCase()} | duration=${fetchDuration}ms | timeout=${timeoutMs}ms`, {
            url: url,
            host: targetHost,
            urlIndex: `${urlIndex}/${fallbackCount}`,
            retryAttempt: retryAttemptsByUrl[urlIndex] || 0,
            errorName: error.name,
            errorMessage: error.message,
            errorCode: error.code,
            errno: error.errno,
            syscall: error.syscall,
            signalAborted: connectCtrl.signal.aborted,
            parentSignalAborted: signal?.aborted || false
          });
        } else {
          console.error(`[FETCH] ❌ error | provider=${this.provider.toUpperCase()} | duration=${fetchDuration}ms`, {
            errorName: error.name,
            errorMessage: error.message,
            errorCode: error.code,
            errno: error.errno,
            syscall: error.syscall,
            address: error.address,
            port: error.port,
            hostname: error.hostname,
            url: url,
            host: targetHost,
            urlIndex: `${urlIndex}/${fallbackCount}`,
            retryAttempt: retryAttemptsByUrl[urlIndex] || 0,
            isConnectTimeout: isConnectTimeout
          });
        }

        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        lastError = error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
