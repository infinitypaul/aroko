import { type Message, Role } from "@a2a-js/sdk";
import {
  PAIRMESH_ECHO_SKILL_ID,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PAIRMESH_SESSION_SKILL_ID,
  PairMeshA2APayloadEnvelopeSchema,
  PairMeshJoinRequestEnvelopeSchema,
  PairMeshJoinResponseEnvelopeSchema,
  type PairMeshA2APayloadEnvelope,
  type PairMeshJoinRequest,
  type PairMeshJoinResponse
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";

export function agentCardHasPairMeshSessionSkill(agentCard: {
  skills: Array<{ id: string }>;
}): boolean {
  return agentCard.skills.some((skill) => skill.id === PAIRMESH_SESSION_SKILL_ID);
}

export function encodePairMeshJoinRequest(request: PairMeshJoinRequest): Message {
  const envelope = PairMeshJoinRequestEnvelopeSchema.parse({
    type: "pairmesh.join.request",
    payload: request
  });

  return buildPairMeshMessage(JSON.stringify(envelope));
}

export function encodePairMeshJoinResponse(response: PairMeshJoinResponse): Message {
  const envelope = PairMeshJoinResponseEnvelopeSchema.parse({
    type: "pairmesh.join.response",
    payload: response
  });

  return buildPairMeshMessage(JSON.stringify(envelope));
}

export function parsePairMeshPayloadFromMessage(
  message: Message
): PairMeshA2APayloadEnvelope | null {
  const pairMeshPart = message.parts.find(
    (part) =>
      part.content?.$case === "text" &&
      (part.mediaType === PAIRMESH_PAYLOAD_MEDIA_TYPE || part.mediaType === "application/json")
  );

  if (!pairMeshPart || pairMeshPart.content?.$case !== "text") {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(pairMeshPart.content.value);
  } catch {
    return null;
  }

  const parsed = PairMeshA2APayloadEnvelopeSchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}

export function extractTextFromMessage(message: Message): string {
  const textPart = message.parts.find((part) => part.content?.$case === "text");
  if (!textPart || textPart.content?.$case !== "text") {
    return "";
  }
  return textPart.content.value;
}

function buildPairMeshMessage(body: string): Message {
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
    metadata: { "pairmesh.skill": PAIRMESH_SESSION_SKILL_ID },
    extensions: [],
    referenceTaskIds: []
  };
}

export { PAIRMESH_ECHO_SKILL_ID, PAIRMESH_SESSION_SKILL_ID };
