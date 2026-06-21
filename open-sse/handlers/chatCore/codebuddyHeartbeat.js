/**
 * CodeBuddy Heartbeat & Stream Monitor Module
 *
 * State-of-the-art stream monitoring based on CodeBuddy CLI (v2.106.3) architecture.
 *
 * Architecture (verified from CLI source):
 * - Upstream sends heartbeats every 30s (`: heartbeat\n\n`)
 * - LivenessWatchdog checks every 30s, triggers recovery if >90s no activity
 * - Activity = Heartbeat OR Content chunk (both reset lastActivityAt)
 * - Thinking Mode detection via SSE events (content_block_start with type: "thinking")
 * - Stall timeout: 1200s (20 min) for total stream duration
 *
 * Key insights from CLI analysis:
 * 1. LivenessWatchdog uses 30s check + 90s stuck threshold (not adaptive timeouts)
 * 2. Server sends `: heartbeat\n\n` every 30s during extended reasoning
 * 3. Empty `reasoning_content` chunks count as activity during thinking mode
 * 4. Heartbeats prevent reverse proxies from closing idle connections
 */

const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds (matches CLI)
const CODEBUDDY_STALL_TIMEOUT_MS = 1200000; // 20 minutes total duration (matches CLI)
const HEARTBEAT_PAYLOAD = ": heartbeat\n\n"; // SSE comment format

// LivenessWatchdog constants (from CLI DEFAULT_LIVENESS_*)
const DEFAULT_LIVENESS_CHECK_INTERVAL_MS = 30000; // Check every 30s
const DEFAULT_LIVENESS_STUCK_MS = 90000; // 90s = "server is dead"

/**
 * Check if provider needs heartbeat mechanism
 */
export function needsHeartbeat(provider) {
  return provider === "codebuddy" || provider === "codebuddy-cn";
}

/**
 * Get CodeBuddy-specific stall timeout
 */
export function getStallTimeout(provider) {
  return needsHeartbeat(provider) ? CODEBUDDY_STALL_TIMEOUT_MS : 180000; // 3min default
}

/**
 * CodeBuddy SSE headers - prevents proxy buffering and connection reclamation
 */
export function getCodeBuddySSEHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
    "X-Proxy-Buffering": "no"
  };
}

/**
 * LivenessWatchdog - monitors stream activity and detects stuck connections
 *
 * Based on CLI implementation:
 * - Checks lastActivityAt every intervalMs (default 30s)
 * - Triggers onStuck() if >stuckMs (default 90s) since last activity
 * - Activity includes: heartbeats, content chunks, thinking deltas
 */
export class LivenessWatchdog {
  constructor(deps, options = {}) {
    this.deps = deps;
    this.timer = null;
    this.intervalMs = options.intervalMs ?? DEFAULT_LIVENESS_CHECK_INTERVAL_MS;
    this.stuckMs = options.stuckMs ?? DEFAULT_LIVENESS_STUCK_MS;
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    try {
      if (!this.deps.isActive()) {
        this.stop();
        return;
      }

      const idle = Date.now() - this.deps.getLastActivityAt();
      if (idle > this.stuckMs) {
        this.stop();
        this.deps.logger.warn(
          `[${this.deps.label}] liveness stuck for ${idle}ms ` +
          `(no upstream activity), triggering recovery`
        );
        try {
          this.deps.onStuck(idle);
        } catch (err) {
          this.deps.logger.warn(
            `[${this.deps.label}] onStuck threw: ${err?.message ?? err}`
          );
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        `[${this.deps.label}] tick threw: ${err?.message ?? err}`
      );
    }
  }
}

/**
 * Create heartbeat injector transform stream
 *
 * Injects SSE comment heartbeat every 30 seconds to keep client connection alive.
 * This is critical during extended reasoning phases where upstream goes silent.
 *
 * SSE comments (lines starting with ":") are ignored by SSE parsers but keep
 * the TCP connection alive through proxies and load balancers.
 */
export function createHeartbeatInjector(options = {}) {
  const {
    signal = null,
    isActive = null,
    intervalMs = HEARTBEAT_INTERVAL_MS
  } = options;

  let heartbeatTimer = null;
  let lastHeartbeatAt = 0;
  let heartbeatCount = 0;
  let isStreamClosed = false;
  let removeAbortListener = null;

  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (removeAbortListener) {
      removeAbortListener();
      removeAbortListener = null;
    }
    isStreamClosed = true;
  };

  return new TransformStream({
    start(controller) {
      if (signal?.aborted || isActive?.() === false) {
        cleanup();
        return;
      }

      if (signal) {
        const onAbort = () => cleanup();
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }

      // Start heartbeat timer immediately
      heartbeatTimer = setInterval(() => {
        // Guard: don't write to closed stream
        if (isStreamClosed || signal?.aborted || isActive?.() === false) {
          cleanup();
          return;
        }

        try {
          const now = Date.now();

          // Encode heartbeat as SSE comment
          const encoder = new TextEncoder();
          const heartbeatBytes = encoder.encode(HEARTBEAT_PAYLOAD);

          // Inject heartbeat into stream
          controller.enqueue(heartbeatBytes);

          heartbeatCount++;
          const timeSinceLast = lastHeartbeatAt > 0 ? Math.round((now - lastHeartbeatAt) / 1000) : 0;
          lastHeartbeatAt = now;

          // Log first heartbeat and every 10th heartbeat
          if (heartbeatCount === 1 || heartbeatCount % 10 === 0) {
            console.log(`[HEARTBEAT] 💓 Sent ${heartbeatCount} heartbeats (${timeSinceLast}s since last)`);
          }
        } catch (err) {
          // ERR_STREAM_WRITE_AFTER_END is expected when stream closes
          if (err.code === 'ERR_STREAM_WRITE_AFTER_END' || err.message?.includes('closed')) {
            cleanup();
          } else {
            console.error("[HEARTBEAT] Failed to inject heartbeat:", err.message);
            cleanup();
          }
        }
      }, intervalMs);
      heartbeatTimer.unref?.();
    },

    transform(chunk, controller) {
      // Guard: don't process if stream is closed
      if (isStreamClosed) return;

      // Pass through all upstream data unchanged
      try {
        controller.enqueue(chunk);
      } catch (err) {
        // Stream closed during transform
        if (err.code === 'ERR_STREAM_WRITE_AFTER_END' || err.message?.includes('closed')) {
          cleanup();
        }
      }
    },

    flush(controller) {
      // Clean up heartbeat timer when stream ends
      if (heartbeatCount > 0) {
        console.log(`[HEARTBEAT] ✅ Stream complete, sent ${heartbeatCount} heartbeats total`);
      }
      cleanup();
    },

    cancel() {
      // Clean up on stream cancellation
      cleanup();
    }
  });
}

/**
 * Detect if SSE line is a heartbeat comment
 *
 * CodeBuddy sends `: heartbeat\n\n` which starts with ":"
 * This is standard SSE comment format
 */
function isHeartbeatComment(chunk) {
  if (!(chunk instanceof Uint8Array)) return false;

  const decoder = new TextDecoder();
  const text = decoder.decode(chunk).trim();

  // Check if line starts with ":" (SSE comment)
  return text.startsWith(':');
}

/**
 * Detect thinking mode from SSE event
 *
 * CLI detects via: content_block_start with type: "thinking"
 * Also tracks: reasoning_content chunks (even empty ones count as activity)
 */
function detectThinkingMode(chunk) {
  if (!(chunk instanceof Uint8Array)) return { isThinking: false, hasReasoningContent: false };

  const decoder = new TextDecoder();
  const text = decoder.decode(chunk);

  // Check for content_block_start with type: "thinking"
  const isThinkingBlock = text.includes('"type":"thinking"') ||
                          text.includes('"type": "thinking"');

  // Check for reasoning_content (even empty string counts)
  const hasReasoningContent = text.includes('"reasoning_content"');

  return {
    isThinking: isThinkingBlock,
    hasReasoningContent: hasReasoningContent
  };
}

/**
 * Create upstream stream monitor with activity tracking
 *
 * State-of-the-art monitoring that tracks:
 * - Heartbeat comments (`: heartbeat\n\n`)
 * - Content chunks (any data)
 * - Thinking mode (content_block_start with type: "thinking")
 * - Reasoning content (even empty chunks count as activity)
 *
 * Activity = Heartbeat OR Content OR Reasoning Content
 * This resets lastActivityAt which LivenessWatchdog monitors
 */
export function createUpstreamMonitor(provider, model, label) {
  let lastActivityAt = Date.now();
  let chunkCount = 0;
  let totalBytes = 0;
  let heartbeatCount = 0;
  let isThinkingMode = false;
  let thinkingStartedAt = null;

  return {
    /**
     * Call this on every upstream chunk received
     *
     * Detects:
     * 1. Heartbeat comments (`: heartbeat\n\n`)
     * 2. Thinking mode (content_block_start with type: "thinking")
     * 3. Reasoning content chunks
     * 4. Regular content chunks
     *
     * All of these reset lastActivityAt
     */
    onChunk(chunk) {
      const now = Date.now();

      // Track basic stats
      chunkCount++;
      totalBytes += chunk.length;

      // Detect heartbeat comments
      if (isHeartbeatComment(chunk)) {
        heartbeatCount++;
        lastActivityAt = now; // Heartbeat = activity

        if (heartbeatCount === 1 || heartbeatCount % 10 === 0) {
          console.log(`[UPSTREAM] 💓 Heartbeat #${heartbeatCount} received`);
        }
        return;
      }

      // Detect thinking mode
      const thinking = detectThinkingMode(chunk);
      if (thinking.isThinking && !isThinkingMode) {
        isThinkingMode = true;
        thinkingStartedAt = now;
        console.log(`[UPSTREAM] 🧠 Thinking mode started`);
      }

      // Reasoning content counts as activity (even empty chunks)
      if (thinking.hasReasoningContent) {
        lastActivityAt = now;
        return;
      }

      // Regular content chunk = activity
      lastActivityAt = now;

      // Log when thinking mode ends (first non-reasoning chunk after thinking)
      if (isThinkingMode && thinkingStartedAt) {
        const thinkingDuration = Math.round((now - thinkingStartedAt) / 1000);
        console.log(`[UPSTREAM] ✅ Thinking mode ended after ${thinkingDuration}s`);
        isThinkingMode = false;
        thinkingStartedAt = null;
      }
    },

    /**
     * Get current activity timestamp (for LivenessWatchdog)
     */
    getLastActivityAt() {
      return lastActivityAt;
    },

    /**
     * Get current stats
     */
    getStats() {
      return {
        chunkCount,
        totalBytes,
        heartbeatCount,
        isThinkingMode,
        timeSinceLastActivity: Date.now() - lastActivityAt
      };
    },

    /**
     * Reset monitor state
     */
    reset() {
      lastActivityAt = Date.now();
      chunkCount = 0;
      totalBytes = 0;
      heartbeatCount = 0;
      isThinkingMode = false;
      thinkingStartedAt = null;
    }
  };
}

/**
 * Create upstream stall monitor (legacy compatibility)
 *
 * Monitors upstream data flow with 1-second polling.
 * Throws error if no data received for stall timeout period.
 *
 * Key insight: Heartbeat is sent downstream (to client), but stall monitor
 * watches upstream (from CodeBuddy). These are independent.
 *
 * @deprecated Use createUpstreamMonitor + LivenessWatchdog instead
 */
export function createStallMonitor(provider, model, stallTimeoutMs) {
  let lastDataAt = Date.now();
  let chunkCount = 0;
  let totalBytes = 0;
  let monitorTimer = null;

  return {
    /**
     * Call this on every upstream chunk received
     */
    onData(chunk) {
      lastDataAt = Date.now();
      chunkCount++;
      totalBytes += chunk.length;
    },

    /**
     * Start monitoring (call when stream begins)
     */
    start() {
      lastDataAt = Date.now();
      chunkCount = 0;
      totalBytes = 0;

      monitorTimer = setInterval(() => {
        const elapsed = Date.now() - lastDataAt;

        if (elapsed >= stallTimeoutMs) {
          const error = new Error(
            `Upstream stall timeout: no data for ${Math.round(elapsed / 1000)}s ` +
            `(timeout: ${stallTimeoutMs / 1000}s, chunks: ${chunkCount}, bytes: ${totalBytes})`
          );
          error.name = "UpstreamStallTimeout";
          error.code = "UPSTREAM_STALL";
          throw error;
        }
      }, 1000); // Check every 1 second
    },

    /**
     * Stop monitoring (call when stream ends)
     */
    stop() {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
    },

    /**
     * Get current stats
     */
    getStats() {
      return {
        chunkCount,
        totalBytes,
        timeSinceLastData: Date.now() - lastDataAt
      };
    }
  };
}
