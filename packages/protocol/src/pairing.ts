import * as z from "zod";
import {
  PairMeshBearerTokenSchema,
  PairMeshInviteSecretSchema,
  PairMeshSecurityVersionSchema
} from "./auth.js";
import { PairMeshAgentSchema } from "./agent.js";
import { PairMeshDeveloperSchema } from "./developer.js";
import { PairMeshDeviceSchema } from "./device.js";
import { PairMeshErrorSchema } from "./errors/schema.js";
import { PeerIdSchema } from "./ids.js";
import { SessionCodeSchema } from "./session-code.js";
import { PairMeshSessionParticipantSchema, PairMeshSessionSchema } from "./session.js";
import { PairMeshMetadataVersionSchema } from "./version.js";
import {
  PairMeshActionRequestEnvelopeSchema,
  PairMeshActionResponseEnvelopeSchema
} from "./action.js";
import {
  PairMeshTaskRequestEnvelopeSchema,
  PairMeshTaskResponseEnvelopeSchema
} from "./input-request.js";
import {
  PairMeshInspectionRequestEnvelopeSchema,
  PairMeshInspectionResponseEnvelopeSchema,
  PairMeshInspectProgressEnvelopeSchema
} from "./inspection.js";

/** A2A Agent Card skill id for PairMesh session collaboration handshake. */
export const PAIRMESH_SESSION_SKILL_ID = "pairmesh.session" as const;

/** A2A Agent Card skill id for low-level PairMesh echo demo. */
export const PAIRMESH_ECHO_SKILL_ID = "pairmesh.echo" as const;

export { PAIRMESH_INSPECT_SKILL_ID } from "./inspection.js";
export { PAIRMESH_ACTION_SKILL_ID } from "./action.js";
export { PAIRMESH_TASK_SKILL_ID } from "./input-request.js";

/** Media type for PairMesh application payloads carried in A2A message parts. */
export const PAIRMESH_PAYLOAD_MEDIA_TYPE = "application/vnd.pairmesh+json" as const;

export const PairMeshJoinParticipantPayloadSchema = z
  .strictObject({
    peerId: PeerIdSchema,
    developer: PairMeshDeveloperSchema,
    device: PairMeshDeviceSchema,
    agent: PairMeshAgentSchema,
    a2aAgentUrl: z.url(),
        transportPublicKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional()
  })
  .describe("Joining participant metadata sent in a PairMesh join request.");
export type PairMeshJoinParticipantPayload = z.infer<typeof PairMeshJoinParticipantPayloadSchema>;

export const PairMeshJoinRequestSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    sessionCode: SessionCodeSchema,
    /** Single-use invite secret proving the joiner was invited by the creator. */
    inviteSecret: PairMeshInviteSecretSchema,
    /** Token the joiner will accept on inbound creator → joiner calls. */
    offeredInboundBearer: PairMeshBearerTokenSchema,
    participant: PairMeshJoinParticipantPayloadSchema
  })
  .describe("PairMesh session join request payload (application semantics over A2A).");
export type PairMeshJoinRequest = z.infer<typeof PairMeshJoinRequestSchema>;

export const PairMeshJoinParticipantRecordSchema = z
  .strictObject({
    participant: PairMeshSessionParticipantSchema,
    developer: PairMeshDeveloperSchema,
    device: PairMeshDeviceSchema,
    agent: PairMeshAgentSchema,
    a2aAgentUrl: z.url(),
    /** Optional peer transport public key mirrored after authenticated join. */
    transportPublicKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional()
  })
  .describe("Registered session participant returned in a PairMesh join response.");
export type PairMeshJoinParticipantRecord = z.infer<typeof PairMeshJoinParticipantRecordSchema>;

export const PairMeshJoinSuccessResponseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    accepted: z.literal(true),
    session: PairMeshSessionSchema,
    sessionCode: SessionCodeSchema,
    securityVersion: PairMeshSecurityVersionSchema,
    /**
     * Token the joiner must present on inbound joiner → creator calls. Returned
     * exactly once, in the join response; the creator persists only its hash.
     */
    issuedBearer: PairMeshBearerTokenSchema,
    participants: z.array(PairMeshJoinParticipantRecordSchema).min(1),
    /** Creator's X25519 transport public key when E2E relay is enabled. */
    transportPublicKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional()
  })
  .describe("Successful PairMesh session join response.");
export type PairMeshJoinSuccessResponse = z.infer<typeof PairMeshJoinSuccessResponseSchema>;

export const PairMeshJoinFailureResponseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    accepted: z.literal(false),
    error: PairMeshErrorSchema
  })
  .describe("Rejected PairMesh session join response.");
export type PairMeshJoinFailureResponse = z.infer<typeof PairMeshJoinFailureResponseSchema>;

export const PairMeshJoinResponseSchema = z.discriminatedUnion("accepted", [
  PairMeshJoinSuccessResponseSchema,
  PairMeshJoinFailureResponseSchema
]);
export type PairMeshJoinResponse = z.infer<typeof PairMeshJoinResponseSchema>;

export const PairMeshJoinRequestEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.join.request"),
  payload: PairMeshJoinRequestSchema
});

export const PairMeshJoinResponseEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.join.response"),
  payload: PairMeshJoinResponseSchema
});

export const PairMeshA2APayloadEnvelopeSchema = z.discriminatedUnion("type", [
  PairMeshJoinRequestEnvelopeSchema,
  PairMeshJoinResponseEnvelopeSchema,
  PairMeshInspectionRequestEnvelopeSchema,
  PairMeshInspectionResponseEnvelopeSchema,
  PairMeshInspectProgressEnvelopeSchema,
  PairMeshActionRequestEnvelopeSchema,
  PairMeshActionResponseEnvelopeSchema,
  PairMeshTaskRequestEnvelopeSchema,
  PairMeshTaskResponseEnvelopeSchema
]);
export type PairMeshA2APayloadEnvelope = z.infer<typeof PairMeshA2APayloadEnvelopeSchema>;
