import {
  PAIRMESH_METADATA_VERSION,
  PairMeshJoinRequestSchema,
  PeerIdSchema,
  createPairMeshError,
  parsePairMeshMetadata,
  type PairMeshBearerToken,
  type PairMeshInviteSecret,
  type PairMeshJoinRequest,
  type PairMeshJoinResponse
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { createLocalPairMeshIdentity, normalizeAgentBaseUrl } from "../identity.js";
import { discoverA2AAgentCard } from "./adapter.js";
import { createPairMeshA2AClient } from "./client-factory.js";
import {
  agentCardHasPairMeshSessionSkill,
  encodePairMeshJoinRequest,
  parsePairMeshPayloadFromMessage
} from "./pairing-messages.js";

export async function sendPairMeshJoinRequest(
  creatorAgentUrl: string,
  request: PairMeshJoinRequest
): Promise<PairMeshJoinResponse> {
  const baseUrl = normalizeAgentBaseUrl(creatorAgentUrl);
  const agentCard = await discoverA2AAgentCard(baseUrl);
  assertPairMeshSessionSkill(agentCard);

  // Join is the one unauthenticated call: the invite secret in the payload is
  // the credential, and the session bearer does not exist yet.
  const client = await createPairMeshA2AClient(baseUrl);
  const response = await client.sendMessage({
    tenant: "",
    message: encodePairMeshJoinRequest(request),
    configuration: {
      acceptedOutputModes: ["application/vnd.pairmesh+json", "text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: false
    },
    metadata: { "pairmesh.skill": "pairmesh.session" }
  });

  const responseMessage = "parts" in response ? response : response.status?.message;
  if (!responseMessage) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh join response did not include a message payload."
    });
  }

  const envelope = parsePairMeshPayloadFromMessage(responseMessage);
  if (!envelope || envelope.type !== "pairmesh.join.response") {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh join response payload was missing or malformed."
    });
  }

  return envelope.payload;
}

export function assertPairMeshSessionSkill(agentCard: { skills: Array<{ id: string }> }): void {
  if (!agentCardHasPairMeshSessionSkill(agentCard)) {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "Peer agent does not expose PairMesh session collaboration capability.",
      details: { requiredSkill: "pairmesh.session" }
    });
  }
}

export interface JoinRequestCredentials {
  /** Single-use invite secret shared out-of-band by the session creator. */
  inviteSecret: PairMeshInviteSecret | string;
  /** Token this joiner will accept on inbound creator → joiner calls. */
  offeredInboundBearer: PairMeshBearerToken | string;
}

export function buildJoinRequest(
  sessionCode: PairMeshJoinRequest["sessionCode"],
  identity: ReturnType<typeof createLocalPairMeshIdentity>,
  agentUrl: string,
  credentials: JoinRequestCredentials,
  options?: { peerId?: string }
): PairMeshJoinRequest {
  const parsed = parsePairMeshMetadata(PairMeshJoinRequestSchema, {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    sessionCode,
    inviteSecret: credentials.inviteSecret,
    offeredInboundBearer: credentials.offeredInboundBearer,
    participant: {
      peerId: PeerIdSchema.parse(options?.peerId ?? `peer_${randomUUID()}`),
      developer: identity.developer,
      device: identity.device,
      agent: identity.agent,
      a2aAgentUrl: normalizeAgentBaseUrl(agentUrl)
    }
  });

  if (!parsed.ok) {
    throw parsed.error;
  }

  return parsed.value;
}
