import { afterEach, describe, expect, it, vi } from "vitest";

import { createHeartbeatInjector, LivenessWatchdog } from "../../open-sse/handlers/chatCore/codebuddyHeartbeat.js";

describe("CodeBuddy LivenessWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling when the stream is no longer active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let active = true;
    const onStuck = vi.fn();
    const watchdog = new LivenessWatchdog({
      label: "codebuddy-cn-test",
      isActive: () => active,
      getLastActivityAt: () => 0,
      logger: { warn: vi.fn() },
      onStuck,
    }, {
      intervalMs: 100,
      stuckMs: 1000,
    });

    watchdog.start();
    active = false;

    vi.advanceTimersByTime(100);
    expect(watchdog.timer).toBeNull();

    vi.advanceTimersByTime(5000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it("stops after triggering stuck recovery once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const onStuck = vi.fn();
    const logger = { warn: vi.fn() };
    const watchdog = new LivenessWatchdog({
      label: "codebuddy-cn-test",
      isActive: () => true,
      getLastActivityAt: () => 0,
      logger,
      onStuck,
    }, {
      intervalMs: 100,
      stuckMs: 90,
    });

    watchdog.start();

    vi.advanceTimersByTime(100);
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck).toHaveBeenCalledWith(100);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(watchdog.timer).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });
});

describe("CodeBuddy heartbeat injector", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans up its heartbeat interval when the stream aborts", () => {
    vi.useFakeTimers();

    const abortController = new AbortController();
    createHeartbeatInjector({
      signal: abortController.signal,
      intervalMs: 100,
    });

    expect(vi.getTimerCount()).toBe(1);

    abortController.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up its heartbeat interval when the stream is no longer active", () => {
    vi.useFakeTimers();

    let active = true;
    createHeartbeatInjector({
      isActive: () => active,
      intervalMs: 100,
    });

    expect(vi.getTimerCount()).toBe(1);

    active = false;
    vi.advanceTimersByTime(100);

    expect(vi.getTimerCount()).toBe(0);
  });
});
