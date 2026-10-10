import * as z from "zod";
import {
  ActionArtifactRecordSchema,
  ActionExecutionRecordSchema,
  CollaborativeTaskSchema,
  ContinuationEventSchema,
  HostToolCallRecordSchema,
  InputRequestSchema,
  InspectionExecutionRecordSchema,
  PairMeshAgentSchema,
  PairMeshBearerTokenSchema,
  PairMeshDeveloperSchema,
  PairMeshDeviceSchema,
  PairMeshInspectionThreadSchema,
  PairMeshInspectionTurnSchema,
  PairMeshInspectionTurnResultSchema,
  PairMeshPermissionRequestSchema,
  PairMeshSessionParticipantSchema,
  PairMeshSessionSchema,
  PairMeshSessionSecuritySchema,
  ProviderTurnSchema,
  SessionCodeSchema
} from "@pairmesh/protocol";

export const LOCAL_STATE_VERSION = "0.6.0" as const;

const PRE_AUTH_STATE_VERSIONS = new Set(["0.1.0", "0.2.0", "0.3.0"]);

const PRE_CAPABILITY_STATE_VERSIONS = new Set(["0.4.0"]);
const PRE_ACTION_STATE_VERSIONS = new Set(["0.5.0"]);

export const LocalParticipantRecordSchema = z
  .strictObject({
    participant: PairMeshSessionParticipantSchema,
    agent: PairMeshAgentSchema,
    developer: PairMeshDeveloperSchema,
    device: PairMeshDeviceSchema.optional(),
    a2aAgentUrl: z.url(),
    isLocal: z.boolean(),
    /**
     * Plaintext bearer this agent presents when calling the peer. Held locally
     * only; the peer stores just its hash.
     */
    outboundBearer: PairMeshBearerTokenSchema.optional(),
        connectivity: z
      .strictObject({
        mode: z.enum(["direct-url", "overlay", "relay"]),
        relayHandle: z.string().trim().min(8).max(80).optional(),
        peerTransportPublicKey: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .optional(),
                relayPresenceId: z.string().trim().min(1).max(120).optional()
      })
      .optional(),
    /**
     * Optional safe service/project label for human selection (e.g. payment-service).
     * Never an absolute filesystem path. Not a security identity.
     */
    serviceLabel: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional()
  })
  .describe("Local session participant record including A2A endpoint reference.");
export type LocalParticipantRecord = z.infer<typeof LocalParticipantRecordSchema>;

export const LocalInspectionTurnRecordSchema = z
  .strictObject({
    turn: PairMeshInspectionTurnSchema,
    result: PairMeshInspectionTurnResultSchema.optional()
  })
  .describe("Persisted inspection turn with optional sanitized result.");
export type LocalInspectionTurnRecord = z.infer<typeof LocalInspectionTurnRecordSchema>;

export const LocalInspectionExecutionRecordSchema = InspectionExecutionRecordSchema.describe(
  "Local inspection execution tracking — separate from thread lifecycle."
);
export type LocalInspectionExecutionRecord = z.infer<typeof LocalInspectionExecutionRecordSchema>;

export const LocalInspectionThreadRecordSchema = z
  .strictObject({
    thread: PairMeshInspectionThreadSchema,
    targetPeerName: z.string().trim().min(1).max(80),
    turns: z.array(LocalInspectionTurnRecordSchema),
    /** Receiver-only: local coding-agent session id — never sent over A2A. */
    providerSessionId: z.string().trim().min(1).max(200).optional(),
    /**
     * @deprecated Prefer `providerSessionId`. Retained so existing state files load.
     */
    cursorSessionId: z.string().trim().min(1).max(200).optional()
  })
  .describe("Local inspection thread persistence including turns.");
export type LocalInspectionThreadRecord = z.infer<typeof LocalInspectionThreadRecordSchema>;

const LocalSessionStateBaseSchema = z
  .strictObject({
    stateVersion: z.literal(LOCAL_STATE_VERSION),
    sessionCode: SessionCodeSchema,
    session: PairMeshSessionSchema,
    localParticipant: LocalParticipantRecordSchema,
    peers: z.array(LocalParticipantRecordSchema),
    inspectionThreads: z.array(LocalInspectionThreadRecordSchema).default([]),
    inspectionExecutions: z.array(LocalInspectionExecutionRecordSchema).default([]),
        sessionSecurity: PairMeshSessionSecuritySchema.optional(),
        permissionRequests: z.array(PairMeshPermissionRequestSchema).max(100).default([]),
        actionExecutions: z.array(ActionExecutionRecordSchema).max(500).default([]),
        actionArtifacts: z.array(ActionArtifactRecordSchema).max(500).default([]),
    /** R5 CollaborativeTask parents (receiver-authoritative). */
    collaborativeTasks: z.array(CollaborativeTaskSchema).max(100).default([]),
    /** R5-3 InputRequest records (receiver-authoritative; requester mirrors safe views). */
    inputRequests: z.array(InputRequestSchema).max(100).default([]),
    /** R5-4 durable host-tool call idempotency log. */
    hostToolCalls: z.array(HostToolCallRecordSchema).max(200).default([]),
    /** R5-5 ProviderTurn records (receiver-local). */
    providerTurns: z.array(ProviderTurnSchema).max(200).default([]),
    /** R5-5 ContinuationEvent records (receiver-authoritative). */
    continuationEvents: z.array(ContinuationEventSchema).max(200).default([]),
    /** Set during migration of a pre-auth session; blocks protected operations. */
    requiresRePair: z.boolean().optional()
  })
  .describe("Versioned local-only PairMesh session state persisted on the client machine.");

export const LocalSessionStateSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const migrated = { ...record };
  if (!("inspectionThreads" in migrated)) {
    migrated.inspectionThreads = [];
  }
  if (!("inspectionExecutions" in migrated)) {
    migrated.inspectionExecutions = [];
  }
  if (!("permissionRequests" in migrated)) {
    migrated.permissionRequests = [];
  }
  if (!("actionExecutions" in migrated)) {
    migrated.actionExecutions = [];
  }
  if (!("actionArtifacts" in migrated)) {
    migrated.actionArtifacts = [];
  }
  if (!("collaborativeTasks" in migrated)) {
    migrated.collaborativeTasks = [];
  }
  if (!("inputRequests" in migrated)) {
    migrated.inputRequests = [];
  }
  if (!("hostToolCalls" in migrated)) {
    migrated.hostToolCalls = [];
  }
  if (!("providerTurns" in migrated)) {
    migrated.providerTurns = [];
  }
  if (!("continuationEvents" in migrated)) {
    migrated.continuationEvents = [];
  }
  if (
    typeof migrated.stateVersion === "string" &&
    PRE_AUTH_STATE_VERSIONS.has(migrated.stateVersion)
  ) {
    migrated.stateVersion = LOCAL_STATE_VERSION;
    migrated.requiresRePair = true;
  } else if (
    typeof migrated.stateVersion === "string" &&
    PRE_CAPABILITY_STATE_VERSIONS.has(migrated.stateVersion)
  ) {
        migrated.stateVersion = LOCAL_STATE_VERSION;
  } else if (
    typeof migrated.stateVersion === "string" &&
    PRE_ACTION_STATE_VERSIONS.has(migrated.stateVersion)
  ) {
    migrated.stateVersion = LOCAL_STATE_VERSION;
  }

  // A session without usable security stays loadable so `status` and `doctor`
  // can explain the required re-pair, but never authorizes protected calls.
  const security = migrated.sessionSecurity;
  const hasSecurityVersion =
    typeof security === "object" &&
    security !== null &&
    typeof (security as Record<string, unknown>).securityVersion === "string";
  if (!hasSecurityVersion) {
    delete migrated.sessionSecurity;
    migrated.requiresRePair = true;
  }

  return migrated;
}, LocalSessionStateBaseSchema);

export type LocalSessionState = z.infer<typeof LocalSessionStateBaseSchema>;
