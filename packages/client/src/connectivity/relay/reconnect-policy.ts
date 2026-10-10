
export const RELAY_RECONNECT_INITIAL_MS = 500;
export const RELAY_RECONNECT_MAX_MS = 30_000;
export const RELAY_RECONNECT_STABLE_MS = 10_000;
/** App-level ping interval — must stay under RELAY_IDLE_TIMEOUT_MS (5m). */
export const RELAY_KEEPALIVE_INTERVAL_MS = 45_000;
/**
 * Max wait for a pong after sending a ping. Well under keepalive interval so a
 * half-open socket fails before the next ping, with slack for normal scheduling.
 */
export const RELAY_PONG_DEADLINE_MS = 10_000;
/**
 * Monotonic gap across keepalive ticks that implies process suspension (sleep).
 * Must exceed normal GC/scheduling jitter and (interval + deadline) skew.
 */
export const RELAY_SUSPENSION_GAP_MS = 90_000;
/** While reconnecting, poll for usable NIC restoration this often. */
export const RELAY_NETWORK_RESTORE_POLL_MS = 2_000;
/** Auth/config failures: long pause, not aggressive spin. */
export const RELAY_AUTH_RETRY_MS = 60_000;
export const RELAY_AUTH_MAX_ATTEMPTS = 3;

export type RelayReconnectErrorClass = "retryable" | "auth" | "terminal";

export type RelayReconnectTriggerReason =
  | "ws_disconnect"
  | "pong_timeout"
  | "suspension_gap"
  | "network_restored"
  | "explicit"
  | "peer_route_refresh";

export function classifyRelayReconnectError(error: unknown): RelayReconnectErrorClass {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  // Attach denied / missing session is usually a wiped in-memory relay (retryable
  // once creator recreates). True auth terminal is the dedicated error code.
  if (code === "pairmesh.relay_authentication_failed") {
    return "auth";
  }
  if (code === "pairmesh.session_closed" || /leave|cleared|stopped/i.test(message)) {
    return "terminal";
  }
  return "retryable";
}

/**
 * Full-jitter delay for attempt index (0-based): random in [0, min(max, initial * 2^n)].
 * `random` should return a value in [0, 1).
 */
export function nextReconnectDelayMs(
  attempt: number,
  options: {
    initialMs?: number;
    maxMs?: number;
    random?: () => number;
  } = {}
): number {
  const initialMs = options.initialMs ?? RELAY_RECONNECT_INITIAL_MS;
  const maxMs = options.maxMs ?? RELAY_RECONNECT_MAX_MS;
  const random = options.random ?? Math.random;
  const exp = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
  const unit = Math.min(0.999999999, Math.max(0, random()));
  return Math.floor(unit * (exp + 1));
}

/** Strong recovery signals skip waiting out a prior backoff timer. */
export function isImmediateReconnectTrigger(reason: RelayReconnectTriggerReason): boolean {
  return (
    reason === "pong_timeout" ||
    reason === "suspension_gap" ||
    reason === "network_restored" ||
    reason === "explicit" ||
    reason === "peer_route_refresh"
  );
}
