import * as z from "zod";

/** Opaque high-entropy relay routing handle — not SessionCode, invite, or bearer. */
export const RelaySessionIdSchema = z
  .string()
  .regex(/^rly_[0-9a-f]{32}$/)
  .describe("Opaque PairMesh relay session routing id");
export type RelaySessionId = z.infer<typeof RelaySessionIdSchema>;

/** Per-connection credential for attaching to a relay session — not a participant bearer. */
export const RelayAccessTokenSchema = z
  .string()
  .regex(/^rat_[0-9a-f]{48}$/)
  .describe("Relay access token for a single outbound connection");
export type RelayAccessToken = z.infer<typeof RelayAccessTokenSchema>;

export const RelayWireFrameSchema = z.strictObject({
  version: z.literal(1),
  type: z.enum(["attach", "attached", "forward", "error", "ping", "pong", "hello"]),
  relaySessionId: RelaySessionIdSchema.optional(),
  relayAccessToken: RelayAccessTokenSchema.optional(),
  connectionId: z.string().min(8).max(80).optional(),
    toConnectionId: z.string().min(8).max(80).optional(),
  /**
   * Opaque pairwise channel id (`rch_…`). Routing hint + E2E demux key.
   * Not an authorization credential and never sufficient to decrypt.
   */
  channelId: z
    .string()
    .regex(/^rch_[0-9a-f]{32}$/)
    .optional(),
  /** Opaque local participant id for presence/channel binding (not a display name). */
  fromParticipantId: z.string().min(8).max(120).optional(),
  toParticipantId: z.string().min(8).max(120).optional(),
  sequence: z.number().int().nonnegative().optional(),
  /** Base64 ciphertext — never plaintext PairMesh payloads. */
  ciphertextB64: z.string().min(1).optional(),
  /** Public X25519 key (hex) — safe to expose; not a secret. */
  transportPublicKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  /** True once the sender has installed matching E2E keys (post-hello). */
  e2eReady: z.boolean().optional(),
    presenceGeneration: z.number().int().nonnegative().optional(),
  /**
   * Directed: peer should remint its disposable relay connection via existing reconnect.
   * Not a new discovery authority — recovery still requires transport verification.
   */
  routeRefreshRequested: z.boolean().optional(),
  message: z.string().max(400).optional()
});
export type RelayWireFrame = z.infer<typeof RelayWireFrameSchema>;

export const RelayChannelIdSchema = z
  .string()
  .regex(/^rch_[0-9a-f]{32}$/)
  .describe("Opaque pairwise relay channel id");
export type RelayChannelId = z.infer<typeof RelayChannelIdSchema>;

export function createRelaySessionId(randomBytes: (n: number) => Uint8Array): RelaySessionId {
  return RelaySessionIdSchema.parse(`rly_${Buffer.from(randomBytes(16)).toString("hex")}`);
}

export function createRelayAccessToken(randomBytes: (n: number) => Uint8Array): RelayAccessToken {
  return RelayAccessTokenSchema.parse(`rat_${Buffer.from(randomBytes(24)).toString("hex")}`);
}
