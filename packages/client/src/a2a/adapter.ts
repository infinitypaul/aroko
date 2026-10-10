import { type AgentCard, type Message, type Task, Role } from "@a2a-js/sdk";
import { AgentCardResolver } from "@a2a-js/sdk/client";
import { createPairMeshError } from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { normalizeAgentBaseUrl } from "../identity.js";
import { createPairMeshA2AClient } from "./client-factory.js";

export interface A2ASendResult {
  target: string;
  requestText: string;
  responseText: string;
}

export interface A2ASendOptions {
  targetAgentUrl: string;
  message: string;
  /** Optional PairMesh session context attached via A2A request metadata (not A2A semantics). */
  pairmeshSessionId?: string;
    bearerToken?: string;
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

export async function discoverA2AAgentCard(peerAgentUrl: string): Promise<AgentCard> {
  let baseUrl: string;
  try {
    baseUrl = normalizeAgentBaseUrl(peerAgentUrl);
  } catch {
    throw createPairMeshError({
      code: "pairmesh.invalid_reference",
      message: "Invalid peer agent URL.",
      details: { field: "peer" }
    });
  }

  return await AgentCardResolver.default.resolve(baseUrl);
}

export async function sendA2AMessage(options: A2ASendOptions): Promise<A2ASendResult> {
  let baseUrl: string;
  try {
    baseUrl = normalizeAgentBaseUrl(options.targetAgentUrl);
  } catch {
    throw createPairMeshError({
      code: "pairmesh.invalid_reference",
      message: "Invalid target agent URL.",
      details: { field: "target" }
    });
  }

  const metadata =
    options.pairmeshSessionId !== undefined
      ? { "pairmesh.sessionId": options.pairmeshSessionId }
      : undefined;

  const client = await createPairMeshA2AClient(baseUrl, options.bearerToken);
  const response = await client.sendMessage({
    tenant: "",
    message: toUserMessage(options.message),
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: false
    },
    metadata
  });

  return {
    target: baseUrl,
    requestText: options.message,
    responseText: toTextResponse(response)
  };
}
