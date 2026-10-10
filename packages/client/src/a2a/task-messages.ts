import { type Message, Role } from "@a2a-js/sdk";
import {
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PAIRMESH_TASK_SKILL_ID,
  PairMeshTaskRequestEnvelopeSchema,
  PairMeshTaskResponseEnvelopeSchema,
  type PairMeshTaskWireRequest,
  type PairMeshTaskWireResponse
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";

export function agentCardHasPairMeshTaskSkill(agentCard: {
  skills: Array<{ id: string }>;
}): boolean {
  return agentCard.skills.some((skill) => skill.id === PAIRMESH_TASK_SKILL_ID);
}

export function encodePairMeshTaskRequest(request: PairMeshTaskWireRequest): Message {
  const envelope = PairMeshTaskRequestEnvelopeSchema.parse({
    type: "pairmesh.task.request",
    payload: request
  });
  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_TASK_SKILL_ID);
}

export function encodePairMeshTaskResponse(response: PairMeshTaskWireResponse): Message {
  const envelope = PairMeshTaskResponseEnvelopeSchema.parse({
    type: "pairmesh.task.response",
    payload: response
  });
  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_TASK_SKILL_ID);
}

function buildPairMeshSkillMessage(body: string, skillId: string): Message {
  return {
    messageId: randomUUID(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: body },
        metadata: undefined,
        filename: "",
        mediaType: PAIRMESH_PAYLOAD_MEDIA_TYPE
      }
    ],
    metadata: { "pairmesh.skill": skillId },
    extensions: [],
    referenceTaskIds: []
  };
}

export { PAIRMESH_TASK_SKILL_ID };
