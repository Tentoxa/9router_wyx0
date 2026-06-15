/**
 * Request Queue - Limits concurrent requests to prevent server overload
 *
 * Implements Token Bucket rate limiting (like official CodeBuddy CLI)
 * - Token bucket per provider
 * - maxPerMinute limit (tokens refill over time)
 * - maxConcurrent limit (running requests)
 * - Cleanup every 5 minutes for stale buckets (>10min inactive)
 */

class TokenBucket {
  constructor(provider, maxPerMinute = 60, maxConcurrent = 10, queueTimeoutMs = 300000, maxQueueSize = 100) {
    this.provider = provider;
    this.maxPerMinute = maxPerMinute;
    this.maxConcurrent = maxConcurrent;
    this.queueTimeoutMs = queueTimeoutMs; // Default 300s (5 min) - prevents 4-5 retries that cause 278s TTFT
    this.maxQueueSize = maxQueueSize; // P1 FIX: Prevent unbounded queue growth
    this.tokens = maxPerMinute;
    this.running = 0;
    this.queue = [];
    this.lastRefill = Date.now();
    this.lastActivity = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / 60000) * this.maxPerMinute;
    this.tokens = Math.min(this.maxPerMinute, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  canAcquire() {
    this.refill();
    return this.tokens >= 1 && this.running < this.maxConcurrent;
  }

  acquire() {
    this.tokens--;
    this.running++;
    this.lastActivity = Date.now();
  }

  release() {
    this.running = Math.max(0, this.running - 1);
    this.lastActivity = Date.now();
  }

  isStale() {
    const now = Date.now();
    return now - this.lastActivity > 10 * 60 * 1000; // 10 minutes
  }

  async run(fn, outerSignal = null) {
    // P1 FIX: Reject request if queue is full to prevent unbounded growth
    if (!this.canAcquire() && this.queue.length >= this.maxQueueSize) {
      throw new Error(`Queue full: ${this.provider} has ${this.queue.length} pending requests (max: ${this.maxQueueSize})`);
    }

    // Wait if we can't acquire a token (with timeout protection)
    if (!this.canAcquire()) {
      const queuePosition = this.queue.length + 1;
      console.log(`[QUEUE] ${this.provider} | request queued (position ${queuePosition}, tokens: ${Math.floor(this.tokens)}, running: ${this.running}/${this.maxConcurrent})`);

      await new Promise((resolve, reject) => {
        let timeoutId;
        let outerAbortHandler;

        // Cleanup function to clear timeout and remove from queue
        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          if (outerSignal && outerAbortHandler) {
            outerSignal.removeEventListener('abort', outerAbortHandler);
          }
          const index = this.queue.findIndex(item => item.resolve === resolve);
          if (index !== -1) this.queue.splice(index, 1);
        };

        // Set timeout to prevent infinite waiting
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Queue timeout: ${this.provider} request waited ${this.queueTimeoutMs}ms`));
        }, this.queueTimeoutMs);

        // FIX: Bind to outer abort signal to prevent zombie promises on client disconnect
        if (outerSignal) {
          if (outerSignal.aborted) {
            cleanup();
            reject(new Error(`Request aborted while queued for ${this.provider}`));
            return;
          }
          outerAbortHandler = () => {
            cleanup();
            reject(new Error(`Request aborted while queued for ${this.provider}`));
          };
          outerSignal.addEventListener('abort', outerAbortHandler, { once: true });
        }

        // Add to queue with cleanup function
        this.queue.push({ resolve, cleanup });
      });
    }

    // Run the request
    this.acquire();
    console.log(`[QUEUE] ${this.provider} | request started (tokens: ${Math.floor(this.tokens)}, running: ${this.running}/${this.maxConcurrent})`);

    try {
      const result = await fn();
      return result;
    } finally {
      this.release();
      console.log(`[QUEUE] ${this.provider} | request completed (tokens: ${Math.floor(this.tokens)}, running: ${this.running}/${this.maxConcurrent})`);

      // Process next request in queue if we have capacity
      while (this.queue.length > 0 && this.canAcquire()) {
        const next = this.queue.shift();
        next.cleanup(); // Clear timeout
        next.resolve();
      }
    }
  }
}

// Global request queues per provider
const buckets = new Map();

export function getProviderQueue(provider, maxPerMinute = 60, maxConcurrent = 10) {
  const key = provider.toLowerCase();
  if (!buckets.has(key)) {
    buckets.set(key, new TokenBucket(provider, maxPerMinute, maxConcurrent));
  }
  return buckets.get(key);
}

/**
 * Run a function with token bucket rate limiting for a specific provider
 */
export async function withConcurrencyLimit(provider, fn, maxConcurrent = 10, outerSignal = null) {
  // CodeBuddy: 60 requests per minute, max 10 concurrent (matches official CLI)
  const maxPerMinute = provider.toLowerCase().includes('codebuddy') ? 60 : 120;
  const bucket = getProviderQueue(provider, maxPerMinute, maxConcurrent);
  return bucket.run(fn, outerSignal);
}

/**
 * Cleanup stale buckets (called periodically)
 */
export function cleanupStaleBuckets() {
  try {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, bucket] of buckets.entries()) {
      if (bucket.isStale() && bucket.running === 0 && bucket.queue.length === 0) {
        console.log(`[QUEUE] ${bucket.provider} | cleanup stale bucket (inactive for ${Math.round((now - bucket.lastActivity) / 1000)}s)`);
        buckets.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[QUEUE] Cleaned up ${cleanedCount} stale buckets, ${buckets.size} active`);
    }
  } catch (error) {
    console.error('[QUEUE] Error during cleanup:', error.message);
  }
}

// Cleanup every 2 minutes (more aggressive than 5 minutes)
// Use unref() to allow graceful shutdown
const cleanupTimer = setInterval(cleanupStaleBuckets, 2 * 60 * 1000);
cleanupTimer.unref();

/**
 * Get queue statistics for monitoring
 */
export function getQueueStats() {
  const stats = {
    totalBuckets: buckets.size,
    buckets: []
  };

  for (const [key, bucket] of buckets.entries()) {
    stats.buckets.push({
      provider: bucket.provider,
      tokens: Math.floor(bucket.tokens),
      maxTokens: bucket.maxPerMinute,
      running: bucket.running,
      maxRunning: bucket.maxConcurrent,
      queued: bucket.queue.length,
      lastActivity: Math.round((Date.now() - bucket.lastActivity) / 1000) + 's ago'
    });
  }

  return stats;
}
