
import { randomBytes } from "node:crypto";

/** Compact stable metric names. */
export type ReliabilityMetricName =
  | "runtime.start_to_relay_socket"
  | "relay.socket_to_attached"
  | "relay.attached_to_session_ready"
  | "peer.presence_to_ready"
  | "request.delivery"
  | "recovery.trigger_to_local_ready"
  | "recovery.trigger_to_peer_ready"
  | "runtime.upgrade_to_ready";

export type ReliabilityTransport = "relay" | "direct" | "local";

export type ReliabilityOutcome = "success" | "aborted" | "failed";

export type ReliabilityReconnectReason =
  "pong_timeout" | "suspension_gap" | "network_restored" | "ws_disconnect" | "explicit";

export interface ReliabilityMetricRecord {
  v: 1;
  metric: ReliabilityMetricName;
  durationMs: number;
  outcome: ReliabilityOutcome;
  correlationId: string;
  transport?: ReliabilityTransport;
  reason?: string;
  /** Wall-clock for human diagnostics only — not used for duration. */
  timestamp: string;
  buildId: string;
  phase?: string;
}

export interface ReliabilitySpan {
  id: string;
  metric: ReliabilityMetricName;
  correlationId: string;
  startMonoMs: number;
  transport?: ReliabilityTransport;
  reason?: string;
  phase?: string;
  completed: boolean;
}

export type MonotonicNow = () => number;

export function defaultMonotonicNowMs(): number {
  return performance.now();
}

export function newCorrelationId(prefix = "r"): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

const SENSITIVE_KEY =
  /token|secret|password|authorization|bearer|cookie|private|key|prompt|source|artifact|path|home|users\//i;

export function isSensitiveMetricKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function sanitizeMetricFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveMetricKey(key)) {
      continue;
    }
    if (typeof value === "string") {
      if (value.includes("/Users/") || value.includes("/home/") || value.startsWith("file:")) {
        continue;
      }
      if (value.length > 200) {
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export function computeDurationMs(startMonoMs: number, endMonoMs: number): number {
  const raw = endMonoMs - startMonoMs;
  if (!Number.isFinite(raw) || raw < 0) {
    return 0;
  }
  return Math.round(raw * 1000) / 1000;
}

export function summarizeDurations(samples: number[]): {
  count: number;
  min: number;
  max: number;
  median: number;
  p95?: number;
  preliminary: boolean;
  samples: number[];
} {
  const sorted = [...samples].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) {
    return { count: 0, min: 0, max: 0, median: 0, preliminary: true, samples: [] };
  }
  const mid = Math.floor(count / 2);
  const median = count % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const preliminary = count < 10;
  const result: {
    count: number;
    min: number;
    max: number;
    median: number;
    p95?: number;
    preliminary: boolean;
    samples: number[];
  } = {
    count,
    min: sorted[0]!,
    max: sorted[count - 1]!,
    median,
    preliminary,
    samples: sorted
  };
  if (count >= 10) {
    const idx = Math.min(count - 1, Math.ceil(count * 0.95) - 1);
    result.p95 = sorted[Math.max(0, idx)]!;
  }
  return result;
}
