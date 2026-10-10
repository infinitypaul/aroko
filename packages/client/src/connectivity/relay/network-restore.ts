
import { networkInterfaces } from "node:os";
import { RELAY_NETWORK_RESTORE_POLL_MS } from "./reconnect-policy.js";

export type CountUsableInterfaces = () => number;

/** Non-internal IPv4 addresses — proxy for "a usable route may exist." */
export function countUsableIpv4Interfaces(): number {
  try {
    const ifs = networkInterfaces();
    let count = 0;
    for (const list of Object.values(ifs)) {
      for (const addr of list ?? []) {
        if (!addr.internal && addr.family === "IPv4") {
          count += 1;
        }
      }
    }
    return count;
  } catch {
    // Some sandboxes deny uv_interface_addresses — treat as "unknown/present"
    // so we neither throw into reconnect nor false-trigger 0→N restore.
    return 1;
  }
}

export interface NetworkRestoreMonitorOptions {
  onRestore: () => void;
  countInterfaces?: CountUsableInterfaces;
  pollIntervalMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * While active, watches for usable IPv4 interfaces reappearing after none.
 * Does not fire when interfaces were always present (avoids localhost reconnect storms).
 */
export class NetworkRestoreMonitor {
  private readonly onRestore: () => void;
  private readonly countInterfaces: CountUsableInterfaces;
  private readonly pollIntervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private sawZero = false;
  private generation = 0;

  constructor(options: NetworkRestoreMonitorOptions) {
    this.onRestore = options.onRestore;
    this.countInterfaces = options.countInterfaces ?? countUsableIpv4Interfaces;
    this.pollIntervalMs = options.pollIntervalMs ?? RELAY_NETWORK_RESTORE_POLL_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));
  }

  start(): void {
    this.stop();
    this.running = true;
    this.generation += 1;
    this.sawZero = this.countInterfaces() === 0;
    this.arm(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Test hook: one poll cycle. */
  pollForTest(): void {
    if (!this.running) return;
    this.onPoll(this.generation);
  }

  private arm(generation: number): void {
    if (!this.running || generation !== this.generation) {
      return;
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      this.onPoll(generation);
      if (this.running && generation === this.generation) {
        this.arm(generation);
      }
    }, this.pollIntervalMs);
  }

  private onPoll(generation: number): void {
    if (!this.running || generation !== this.generation) {
      return;
    }
    const count = this.countInterfaces();
    if (count === 0) {
      this.sawZero = true;
      return;
    }
    if (this.sawZero && count > 0) {
      this.sawZero = false;
      try {
        this.onRestore();
      } catch {
        /* isolate */
      }
    }
  }
}
