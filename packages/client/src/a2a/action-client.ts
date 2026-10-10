import {
  PAIRMESH_ACTION_SKILL_ID,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  createPairMeshError,
  type PairMeshActionWireRequest,
  type PairMeshActionWireResponse
} from "@pairmesh/protocol";
import { discoverA2AAgentCard } from "./adapter.js";
import { createPairMeshA2AClient } from "./client-factory.js";
import { agentCardHasPairMeshActionSkill, encodePairMeshActionRequest } from "./action-messages.js";
import { parsePairMeshPayloadFromMessage } from "./pairing-messages.js";
import { normalizeAgentBaseUrl } from "../identity.js";

export interface ActionSendOptions {
  bearerToken: string;
  signal?: AbortSignal;
}

export async function sendPairMeshActionRequest(
  targetAgentUrl: string,
  wireRequest: PairMeshActionWireRequest,
  options: ActionSendOptions
): Promise<PairMeshActionWireResponse> {
  const baseUrl = normalizeAgentBaseUrl(targetAgentUrl);
  const agentCard = await discoverA2AAgentCard(baseUrl);
  assertPairMeshActionSkill(agentCard);

  const client = await createPairMeshA2AClient(baseUrl, options.bearerToken);
  const response = await client.sendMessage(
    {
      tenant: "",
      message: encodePairMeshActionRequest(wireRequest),
      configuration: {
        acceptedOutputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE, "text/plain"],
        taskPushNotificationConfig: undefined,
        historyLength: 0,
        returnImmediately: false
      },
      metadata: { "pairmesh.skill": PAIRMESH_ACTION_SKILL_ID }
    },
    options.signal ? { signal: options.signal } : undefined
  );

  const responseMessage = "parts" in response ? response : response.status?.message;
  if (!responseMessage) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh action response did not include a message payload."
    });
  }

  const envelope = parsePairMeshPayloadFromMessage(responseMessage);
  if (!envelope || envelope.type !== "pairmesh.action.response") {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh action response payload was missing or malformed."
    });
  }

  return envelope.payload;
}

export function assertPairMeshActionSkill(agentCard: { skills: Array<{ id: string }> }): void {
  if (!agentCardHasPairMeshActionSkill(agentCard)) {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "Peer agent does not expose PairMesh controlled-action capability.",
      details: { requiredSkill: PAIRMESH_ACTION_SKILL_ID }
    });
  }
}
