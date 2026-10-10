import { type Message, Role } from "@a2a-js/sdk";
import {
  PAIRMESH_ACTION_SKILL_ID,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PairMeshActionRequestEnvelopeSchema,
  PairMeshActionResponseEnvelopeSchema,
  type PairMeshActionWireRequest,
  type PairMeshActionWireResponse
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";

export function agentCardHasPairMeshActionSkill(agentCard: {
  skills: Array<{ id: string }>;
}): boolean {
  return agentCard.skills.some((skill) => skill.id === PAIRMESH_ACTION_SKILL_ID);
}

export function encodePairMeshActionRequest(request: PairMeshActionWireRequest): Message {
  const envelope = PairMeshActionRequestEnvelopeSchema.parse({
    type: "pairmesh.action.request",
    payload: request
  });

  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_ACTION_SKILL_ID);
}

export function encodePairMeshActionResponse(response: PairMeshActionWireResponse): Message {
  const envelope = PairMeshActionResponseEnvelopeSchema.parse({
    type: "pairmesh.action.response",
    payload: response
  });

  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_ACTION_SKILL_ID);
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

export { PAIRMESH_ACTION_SKILL_ID };
