import { type Message, Role } from "@a2a-js/sdk";
import {
  PAIRMESH_INSPECT_SKILL_ID,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PairMeshInspectProgressEnvelopeSchema,
  PairMeshInspectionRequestEnvelopeSchema,
  PairMeshInspectionResponseEnvelopeSchema,
  type PairMeshInspectProgressPayload,
  type PairMeshInspectionRequest,
  type PairMeshInspectionResponse
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";

export function agentCardHasPairMeshInspectSkill(agentCard: {
  skills: Array<{ id: string }>;
}): boolean {
  return agentCard.skills.some((skill) => skill.id === PAIRMESH_INSPECT_SKILL_ID);
}

export function encodePairMeshInspectionRequest(request: PairMeshInspectionRequest): Message {
  const envelope = PairMeshInspectionRequestEnvelopeSchema.parse({
    type: "pairmesh.inspect.request",
    payload: request
  });

  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_INSPECT_SKILL_ID);
}

export function encodePairMeshInspectionResponse(response: PairMeshInspectionResponse): Message {
  const envelope = PairMeshInspectionResponseEnvelopeSchema.parse({
    type: "pairmesh.inspect.response",
    payload: response
  });

  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_INSPECT_SKILL_ID);
}

export function encodePairMeshInspectProgress(payload: PairMeshInspectProgressPayload): Message {
  const envelope = PairMeshInspectProgressEnvelopeSchema.parse({
    type: "pairmesh.inspect.progress",
    payload
  });
  return buildPairMeshSkillMessage(JSON.stringify(envelope), PAIRMESH_INSPECT_SKILL_ID);
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

export { PAIRMESH_INSPECT_SKILL_ID };
