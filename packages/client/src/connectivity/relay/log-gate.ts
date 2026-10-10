
export type RelayLogFn = (
  event: string,
  fields?: Record<string, string | number | boolean>
) => void;

const ALWAYS = new Set([
  "process_listen",
  "process_shutdown",
  "startup_failed",
  "process_signal",
  "connection_rejected_capacity",
  "connection_rejected_unattached",
  "attach_session_full",
  "presence_takeover",
  "slow_consumer_disconnect"
]);

const RATE_LIMITED = new Set([
  "attach_denied",
  "forward_destination_unavailable",
  "destination_backpressure"
]);

const SAMPLED = new Set([
  "connection_opened",
  "connection_closed",
  "attach_success",
  "session_created",
  "access_token_added",
  "rendezvous_registered",
  "connection_idle_closed"
]);

/** Events that must never be logged per occurrence (metrics only). */
export const RELAY_LOG_NEVER = new Set([
  "destination_not_found",
  "invalid_json",
  "invalid_frame"
]);

export interface RelayLogGateStats {
  logEligible: number;
  logEmitted: number;
  logSuppressed: number;
}

export function createRelayLogGate(
  inner: RelayLogFn | undefined,
  options?: { sampleEvery?: number; rateLimitMs?: number }
): { log: RelayLogFn; stats: () => RelayLogGateStats } {
  const sampleEvery = options?.sampleEvery ?? 20;
  const rateLimitMs = options?.rateLimitMs ?? 1000;
  let logEligible = 0;
  let logEmitted = 0;
  let logSuppressed = 0;
  const sampleCounters = new Map<string, number>();
  const lastRate = new Map<string, number>();

  const log: RelayLogFn = (event, fields) => {
    logEligible += 1;
    if (RELAY_LOG_NEVER.has(event)) {
      logSuppressed += 1;
      return;
    }
    if (ALWAYS.has(event)) {
      logEmitted += 1;
      inner?.(event, fields);
      return;
    }
    if (RATE_LIMITED.has(event)) {
      const now = Date.now();
      const prev = lastRate.get(event) ?? 0;
      if (now - prev < rateLimitMs) {
        logSuppressed += 1;
        return;
      }
      lastRate.set(event, now);
      logEmitted += 1;
      inner?.(event, fields);
      return;
    }
    if (SAMPLED.has(event)) {
      const n = (sampleCounters.get(event) ?? 0) + 1;
      sampleCounters.set(event, n);
      if (n % sampleEvery !== 1) {
        logSuppressed += 1;
        return;
      }
      logEmitted += 1;
      inner?.(event, { ...fields, sampled: true, sampleEvery });
      return;
    }
    // Unknown events: emit (conservative for new lifecycle signals)
    logEmitted += 1;
    inner?.(event, fields);
  };

  return {
    log,
    stats: () => ({ logEligible, logEmitted, logSuppressed })
  };
}
