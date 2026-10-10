import { describe, expect, it } from "vitest";
import { RelayLivenessWatchdog } from "./liveness.js";
import { NetworkRestoreMonitor } from "./network-restore.js";
import {
  isImmediateReconnectTrigger,
  RELAY_PONG_DEADLINE_MS,
  RELAY_SUSPENSION_GAP_MS
} from "./reconnect-policy.js";

function createFakeClock() {
  let now = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { fn: () => void; due: number }>();
  let nextId = 1;

  const schedule = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = nextId++ as unknown as ReturnType<typeof setTimeout>;
    timers.set(id, { fn, due: now + ms });
    return id;
  };

  const clearTimer = (id: ReturnType<typeof setTimeout>): void => {
    timers.delete(id);
  };

  const advance = (ms: number): void => {
    now += ms;
    for (;;) {
      let dueId: ReturnType<typeof setTimeout> | undefined;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of timers) {
        if (t.due <= now && t.due < dueAt) {
          dueAt = t.due;
          dueId = id;
        }
      }
      if (dueId === undefined) break;
      const entry = timers.get(dueId);
      timers.delete(dueId);
      entry?.fn();
    }
  };

  return {
    nowMs: () => now,
    setNow: (value: number) => {
      now = value;
    },
    schedule,
    clearTimer,
    advance,
    pendingCount: () => timers.size
  };
}

describe("RelayLivenessWatchdog", () => {
  it("ping → pong → remains healthy (no failure)", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    let pings = 0;
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 50,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => {
        pings += 1;
      },
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    clock.advance(100);
    expect(pings).toBe(1);
    expect(watchdog.hasOutstandingPing).toBe(true);
    watchdog.onPong();
    expect(watchdog.hasOutstandingPing).toBe(false);
    clock.advance(50);
    expect(failures).toEqual([]);
    clock.advance(100);
    expect(pings).toBe(2);
    watchdog.onPong();
    expect(failures).toEqual([]);
    watchdog.stop();
  });

  it("ping → no pong → pong_timeout failure", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 40,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => undefined,
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    clock.advance(100);
    expect(watchdog.hasOutstandingPing).toBe(true);
    clock.advance(40);
    expect(failures).toEqual(["pong_timeout"]);
    expect(watchdog.hasOutstandingPing).toBe(false);
  });

  it("ignores stale/late pongs after deadline", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 30,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => undefined,
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    clock.advance(100);
    clock.advance(30);
    expect(failures).toEqual(["pong_timeout"]);
    watchdog.onPong();
    expect(failures).toEqual(["pong_timeout"]);
  });

  it("timer gap simulating sleep triggers suspension_gap", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 50,
      suspensionGapMs: 500,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => undefined,
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    // Jump monotonic clock as if the process slept through the interval timer.
    clock.setNow(600);
    watchdog.tickForTest();
    expect(failures).toEqual(["suspension_gap"]);
  });

  it("does not treat normal interval skew as suspension", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    let pings = 0;
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 50,
      suspensionGapMs: RELAY_SUSPENSION_GAP_MS,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => {
        pings += 1;
      },
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    clock.advance(100);
    watchdog.onPong();
    // Skew well under default 90s gap
    clock.setNow(clock.nowMs() + 5_000);
    watchdog.tickForTest();
    expect(pings).toBe(2);
    expect(failures).toEqual([]);
    watchdog.onPong();
  });

  it("stop cancels watchdog; late timers do not fail", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 50,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => undefined,
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    clock.advance(100);
    watchdog.stop();
    clock.advance(1_000);
    expect(failures).toEqual([]);
  });

  it("start after failure resets outstanding ping state", () => {
    const clock = createFakeClock();
    const failures: string[] = [];
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 100,
      pongDeadlineMs: 20,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => undefined,
      onFailure: (reason) => failures.push(reason)
    });
    watchdog.start();
    clock.advance(100);
    clock.advance(20);
    expect(failures).toEqual(["pong_timeout"]);
    watchdog.start();
    expect(watchdog.hasOutstandingPing).toBe(false);
    clock.advance(100);
    expect(watchdog.hasOutstandingPing).toBe(true);
    watchdog.onPong();
    expect(failures).toEqual(["pong_timeout"]);
  });

  it("does not send a second ping while one is outstanding", () => {
    const clock = createFakeClock();
    let pings = 0;
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 50,
      pongDeadlineMs: 200,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => {
        pings += 1;
      },
      onFailure: () => undefined
    });
    watchdog.start();
    clock.advance(50);
    expect(pings).toBe(1);
    clock.advance(50);
    expect(pings).toBe(1);
    watchdog.onPong();
    clock.advance(50);
    expect(pings).toBe(2);
  });
});

describe("NetworkRestoreMonitor", () => {
  it("fires only when usable interfaces go from 0 to >0", () => {
    let count = 1;
    const restores: number[] = [];
    const clock = createFakeClock();
    const monitor = new NetworkRestoreMonitor({
      pollIntervalMs: 10,
      countInterfaces: () => count,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      onRestore: () => restores.push(count)
    });
    monitor.start();
    clock.advance(10);
    expect(restores).toEqual([]);
    count = 0;
    clock.advance(10);
    expect(restores).toEqual([]);
    count = 2;
    clock.advance(10);
    expect(restores).toEqual([2]);
    clock.advance(10);
    expect(restores).toEqual([2]);
  });
});

describe("reconnect trigger helpers", () => {
  it("marks pong/suspension/network/explicit/peer_route_refresh as immediate", () => {
    expect(isImmediateReconnectTrigger("pong_timeout")).toBe(true);
    expect(isImmediateReconnectTrigger("suspension_gap")).toBe(true);
    expect(isImmediateReconnectTrigger("network_restored")).toBe(true);
    expect(isImmediateReconnectTrigger("explicit")).toBe(true);
    expect(isImmediateReconnectTrigger("peer_route_refresh")).toBe(true);
    expect(isImmediateReconnectTrigger("ws_disconnect")).toBe(false);
  });

  it("documents default pong deadline under keepalive", () => {
    expect(RELAY_PONG_DEADLINE_MS).toBe(10_000);
    expect(RELAY_SUSPENSION_GAP_MS).toBe(90_000);
  });
});

describe("liveness failure isolation", () => {
  it("onFailure errors do not throw out of fail path", () => {
    const clock = createFakeClock();
    const watchdog = new RelayLivenessWatchdog({
      pingIntervalMs: 10,
      pongDeadlineMs: 5,
      suspensionGapMs: 1_000,
      nowMs: clock.nowMs,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
      sendPing: () => undefined,
      onFailure: () => {
        throw new Error("handler boom");
      }
    });
    watchdog.start();
    expect(() => clock.advance(20)).not.toThrow();
  });
});
