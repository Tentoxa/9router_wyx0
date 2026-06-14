/**
 * Request Queue - Limits concurrent requests to prevent server overload
 *
 * When too many requests hit a provider simultaneously, the server queues them
 * (causing 53s+ TTFT) or drops them (causing 60s timeouts). This queue
 * implements backpressure to prevent overload.
 */

class RequestQueue {
  constructor(provider, maxConcurrent = 10) {
    this.provider = provider;
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    // If at capacity, wait in queue
    if (this.running >= this.maxConcurrent) {
      const queuePosition = this.queue.length + 1;
      console.log(`[QUEUE] ${this.provider} | request queued (position ${queuePosition}, running ${this.running}/${this.maxConcurrent})`);

      await new Promise(resolve => {
        this.queue.push(resolve);
      });
    }

    // Run the request
    this.running++;
    console.log(`[QUEUE] ${this.provider} | request started (running ${this.running}/${this.maxConcurrent})`);

    try {
      const result = await fn();
      return result;
    } finally {
      this.running--;
      console.log(`[QUEUE] ${this.provider} | request completed (running ${this.running}/${this.maxConcurrent})`);

      // Process next request in queue
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

// Global request queues per provider
const queues = new Map();

export function getProviderQueue(provider, maxConcurrent = 10) {
  const key = provider.toLowerCase();
  if (!queues.has(key)) {
    queues.set(key, new RequestQueue(provider, maxConcurrent));
  }
  return queues.get(key);
}

/**
 * Run a function with concurrency limiting for a specific provider
 */
export async function withConcurrencyLimit(provider, fn, maxConcurrent = 10) {
  const queue = getProviderQueue(provider, maxConcurrent);
  return queue.run(fn);
}
