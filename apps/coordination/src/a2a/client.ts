import { type Message, type Task, Role } from "@a2a-js/sdk";
import { createPairMeshA2AClient } from "@pairmesh/client";
import { createPairMeshError, parsePairMeshMetadata } from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { SendToPeerInputSchema, type SendToPeerInput } from "./types.js";

export interface PairMeshA2ASendResult {
  target: string;
  requestText: string;
  responseText: string;
}

function asTextFromMessage(message: Message): string {
  const textPart = message.parts.find((part) => part.content?.$case === "text");
  if (!textPart || textPart.content?.$case !== "text") {
    return "";
  }
  return textPart.content.value;
}

function asTextFromTask(task: Task): string {
  const statusMessage = task.status?.message;
  if (!statusMessage) {
    return "";
  }
  return asTextFromMessage(statusMessage);
}

function toTextResponse(result: Message | Task): string {
  if ("parts" in result) {
    return asTextFromMessage(result);
  }
  return asTextFromTask(result);
}

function toUserMessage(text: string): Message {
  return {
    messageId: randomUUID(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain"
      }
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

export async function sendToPairMeshPeer(rawInput: unknown): Promise<PairMeshA2ASendResult> {
  const parsed = parsePairMeshMetadata(SendToPeerInputSchema, rawInput);
  if (!parsed.ok) {
    throw parsed.error;
  }

  const input: SendToPeerInput = parsed.value;
  let normalizedTarget: URL;

  try {
    normalizedTarget = new URL(input.target);
  } catch {
    throw createPairMeshError({
      code: "pairmesh.invalid_reference",
      message: "Invalid target URL for peer agent.",
      details: { field: "target" }
    });
  }

  if (normalizedTarget.protocol !== "http:" && normalizedTarget.protocol !== "https:") {
    throw createPairMeshError({
      code: "pairmesh.invalid_reference",
      message: "Peer target must use http or https.",
      details: { field: "target" }
    });
  }

  const baseUrl = normalizedTarget.origin;
  const client = await createPairMeshA2AClient(baseUrl, input.bearerToken);
  const response = await client.sendMessage({
    tenant: "",
    message: toUserMessage(input.message),
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: false
    },
    metadata: undefined
  });

  return {
    target: baseUrl,
    requestText: input.message,
    responseText: toTextResponse(response)
  };
}
