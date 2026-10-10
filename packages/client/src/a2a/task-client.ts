import {
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PAIRMESH_TASK_SKILL_ID,
  createPairMeshError,
  type PairMeshTaskWireRequest,
  type PairMeshTaskWireResponse
} from "@pairmesh/protocol";
import { discoverA2AAgentCard } from "./adapter.js";
import { createPairMeshA2AClient } from "./client-factory.js";
import { agentCardHasPairMeshTaskSkill, encodePairMeshTaskRequest } from "./task-messages.js";
import { parsePairMeshPayloadFromMessage } from "./pairing-messages.js";
import { normalizeAgentBaseUrl } from "../identity.js";

export interface TaskSendOptions {
  bearerToken: string;
  signal?: AbortSignal;
}

export async function sendPairMeshTaskRequest(
  targetAgentUrl: string,
  wireRequest: PairMeshTaskWireRequest,
  options: TaskSendOptions
): Promise<PairMeshTaskWireResponse> {
  const baseUrl = normalizeAgentBaseUrl(targetAgentUrl);
  const agentCard = await discoverA2AAgentCard(baseUrl);
  assertPairMeshTaskSkill(agentCard);

  const client = await createPairMeshA2AClient(baseUrl, options.bearerToken);
  const response = await client.sendMessage(
    {
      tenant: "",
      message: encodePairMeshTaskRequest(wireRequest),
      configuration: {
        acceptedOutputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE, "text/plain"],
        taskPushNotificationConfig: undefined,
        historyLength: 0,
        returnImmediately: false
      },
      metadata: { "pairmesh.skill": PAIRMESH_TASK_SKILL_ID }
    },
    options.signal ? { signal: options.signal } : undefined
  );

  const responseMessage = "parts" in response ? response : response.status?.message;
  if (!responseMessage) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh task response did not include a message payload."
    });
  }

  const envelope = parsePairMeshPayloadFromMessage(responseMessage);
  if (!envelope || envelope.type !== "pairmesh.task.response") {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh task response payload was missing or malformed."
    });
  }

  return envelope.payload;
}

export function assertPairMeshTaskSkill(agentCard: { skills: Array<{ id: string }> }): void {
  if (!agentCardHasPairMeshTaskSkill(agentCard)) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_unsupported",
      message: "Peer agent does not expose PairMesh collaborative-task capability.",
      details: { requiredSkill: PAIRMESH_TASK_SKILL_ID }
    });
  }
}
