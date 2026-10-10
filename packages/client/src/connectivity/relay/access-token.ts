import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { RelayAccessTokenSchema, type RelayAccessToken, type RelaySessionId } from "./frames.js";

export function deriveRelayAccessToken(input: {
  inviteSecret: string;
  sessionCode: string;
  relaySessionId: RelaySessionId;
}): RelayAccessToken {
  const ikm = new TextEncoder().encode(input.inviteSecret.trim());
  const salt = sha256(
    new TextEncoder().encode(`pairmesh-relay-access-v1|${input.sessionCode.trim()}`)
  );
  const info = new TextEncoder().encode(
    `pairmesh-relay-access-v1|${input.relaySessionId}|${input.sessionCode.trim()}`
  );
  const out = hkdf(sha256, ikm, salt, info, 24);
  return RelayAccessTokenSchema.parse(`rat_${Buffer.from(out).toString("hex")}`);
}

export function deriveParticipantRelayAccessToken(input: {
  inviteSecret: string;
  sessionCode: string;
  relaySessionId: RelaySessionId;
  participantId: string;
}): RelayAccessToken {
  const ikm = new TextEncoder().encode(input.inviteSecret.trim());
  const salt = sha256(
    new TextEncoder().encode(
      `pairmesh-relay-access-participant-v1|${input.sessionCode.trim()}|${input.participantId}`
    )
  );
  const info = new TextEncoder().encode(
    `pairmesh-relay-access-participant-v1|${input.relaySessionId}|${input.sessionCode.trim()}|${input.participantId}`
  );
  const out = hkdf(sha256, ikm, salt, info, 24);
  return RelayAccessTokenSchema.parse(`rat_${Buffer.from(out).toString("hex")}`);
}

/** Max encrypted frame JSON size accepted by hosted relay (bytes). */
export const RELAY_MAX_FRAME_BYTES = 256 * 1024;

/** Max concurrent WebSocket connections per process (alpha). */
export const RELAY_MAX_CONNECTIONS = 64;

/** Max physical WebSocket attachments per collaboration relay session. */
export const RELAY_MAX_SESSION_CONNECTIONS = 8;

/** Max logical pairwise channels tracked per local runtime (alpha). */
export const RELAY_MAX_LOGICAL_CHANNELS = 28;

/** Idle WebSocket timeout (ms) for attached connections. */
export const RELAY_IDLE_TIMEOUT_MS = 5 * 60_000;

export const RELAY_UNATTACHED_TIMEOUT_MS = 10_000;

export const RELAY_MAX_UNATTACHED = 8;

export const RELAY_BACKPRESSURE_SOFT_BYTES = 8 * 1024 * 1024;

export const RELAY_BACKPRESSURE_HARD_BYTES = 32 * 1024 * 1024;
