
import {
  RELAY_KEEPALIVE_INTERVAL_MS,
  RELAY_PONG_DEADLINE_MS,
  RELAY_SUSPENSION_GAP_MS
} from "./reconnect-policy.js";

export type RelayLivenessFailureReason = "pong_timeout" | "suspension_gap";

export type RelayLivenessClock = () => number;

export interface RelayLivenessWatchdogOptions {
  /** Interval between ping sends while attached. Default RELAY_KEEPALIVE_INTERVAL_MS. */
  pingIntervalMs?: number;
  /** Max wait for pong after a ping. Default RELAY_PONG_DEADLINE_MS. */
  pongDeadlineMs?: number;
  /**
   * Monotonic gap across successive ticks that implies suspension/sleep.
   * Default RELAY_SUSPENSION_GAP_MS — well above normal scheduling jitter.
   */
  suspensionGapMs?: number;
  /** Prefer monotonic (e.g. performance.now). */
  nowMs?: RelayLivenessClock;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  sendPing: () => void;
  onFailure: (reason: RelayLivenessFailureReason) => void;
}

/**
 * Owns ping cadence, outstanding-ping tracking, pong deadline, and suspension gaps.
 * Does not open sockets — caller supplies sendPing / onFailure.
 */
export class RelayLivenessWatchdog {
  private readonly pingIntervalMs: number;
  private readonly pongDeadlineMs: number;
  private readonly suspensionGapMs: number;
  private readonly nowMs: RelayLivenessClock;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly sendPing: () => void;
  private readonly onFailure: (reason: RelayLivenessFailureReason) => void;

  private running = false;
  private generation = 0;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private outstandingPing = false;
  private failed = false;

  constructor(options: RelayLivenessWatchdogOptions) {
    this.pingIntervalMs = options.pingIntervalMs ?? RELAY_KEEPALIVE_INTERVAL_MS;
    this.pongDeadlineMs = options.pongDeadlineMs ?? RELAY_PONG_DEADLINE_MS;
    this.suspensionGapMs = options.suspensionGapMs ?? RELAY_SUSPENSION_GAP_MS;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.sendPing = options.sendPing;
    this.onFailure = options.onFailure;
  }

  get hasOutstandingPing(): boolean {
    return this.outstandingPing;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start (or restart) the watchdog after attach / successful reconnect. */
  start(): void {
    this.stopTimersOnly();
    this.running = true;
    this.failed = false;
    this.outstandingPing = false;
    this.lastTickAt = this.nowMs();
    this.generation += 1;
    this.armInterval(this.generation);
  }

  /** Cancel all timers; ignore late pongs and in-flight deadlines. */
  stop(): void {
    this.running = false;
    this.generation += 1;
    this.stopTimersOnly();
    this.outstandingPing = false;
    this.lastTickAt = null;
    this.failed = false;
  }

  /**
   * Clear outstanding ping when a pong arrives.
   * Late/stale pongs (no outstanding ping, or after failure/stop) are ignored.
   */
  onPong(): void {
    if (!this.running || this.failed || !this.outstandingPing) {
      return;
    }
    this.outstandingPing = false;
    if (this.pongTimer) {
      this.clearTimer(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Test / injected tick — same path as the interval timer. */
  tickForTest(): void {
    if (!this.running || this.failed) {
      return;
    }
    this.onIntervalTick(this.generation);
  }

  private armInterval(generation: number): void {
    if (!this.running || generation !== this.generation) {
      return;
    }
    this.intervalTimer = this.schedule(() => {
      this.intervalTimer = null;
      this.onIntervalTick(generation);
      if (this.running && !this.failed && generation === this.generation) {
        this.armInterval(generation);
      }
    }, this.pingIntervalMs);
  }

  private onIntervalTick(generation: number): void {
    if (!this.running || this.failed || generation !== this.generation) {
      return;
    }
    const now = this.nowMs();
    if (this.lastTickAt !== null) {
      const gap = now - this.lastTickAt;
      if (gap >= this.suspensionGapMs) {
        this.fail("suspension_gap", generation);
        return;
      }
    }
    this.lastTickAt = now;

    // One outstanding ping at a time — avoids false doubles under scheduling delay.
    if (this.outstandingPing) {
      return;
    }

    try {
      this.sendPing();
    } catch {
      this.fail("pong_timeout", generation);
      return;
    }
    this.outstandingPing = true;
    this.pongTimer = this.schedule(() => {
      this.pongTimer = null;
      if (!this.running || this.failed || generation !== this.generation) {
        return;
      }
      if (!this.outstandingPing) {
        return;
      }
      this.fail("pong_timeout", generation);
    }, this.pongDeadlineMs);
  }

  private fail(reason: RelayLivenessFailureReason, generation: number): void {
    if (!this.running || this.failed || generation !== this.generation) {
      return;
    }
    this.failed = true;
    this.outstandingPing = false;
    this.stopTimersOnly();
    try {
      this.onFailure(reason);
    } catch {
      /* isolate */
    }
  }

  private stopTimersOnly(): void {
    if (this.intervalTimer) {
      this.clearTimer(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.pongTimer) {
      this.clearTimer(this.pongTimer);
      this.pongTimer = null;
    }
  }
}
