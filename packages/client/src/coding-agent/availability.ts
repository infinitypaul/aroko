import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCommandAvailable } from "./acp-client.js";
import {
  createCodingAgentError,
  type CodingAgentAvailability,
  type CodingAgentProviderId
} from "./types.js";

export interface CodingAgentAvailabilityInput {
  provider: CodingAgentProviderId;
  workspace?: string;
  command?: string;
  busy?: boolean;
}

export async function probeCodingAgentAvailability(
  input: CodingAgentAvailabilityInput
): Promise<CodingAgentAvailability> {
  if (input.busy) {
    return {
      provider: input.provider,
      configured: true,
      status: "busy",
      reason: "A coding-agent inspection is already in progress."
    };
  }

  if (input.provider === "fake") {
    const workspace = input.workspace?.trim();
    if (!workspace) {
      return {
        provider: "fake",
        configured: false,
        status: "unavailable",
        reason: "Workspace is not configured."
      };
    }
    try {
      await access(workspace);
      return { provider: "fake", configured: true, status: "available" };
    } catch {
      return {
        provider: "fake",
        configured: false,
        status: "unavailable",
        reason: "Configured workspace does not exist."
      };
    }
  }

  const workspace = input.workspace?.trim();
  if (!workspace) {
    return {
      provider: input.provider,
      configured: false,
      status: "unavailable",
      reason: "PAIRMESH_WORKSPACE is not configured."
    };
  }

  try {
    await access(resolve(workspace));
  } catch {
    return {
      provider: input.provider,
      configured: false,
      status: "unavailable",
      reason: "Configured workspace does not exist."
    };
  }

  const command = input.command ?? defaultCommandForProvider(input.provider);
  try {
    await assertCommandAvailable(command);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : isCodingAgentErrorLike(error)
          ? error.message
          : `${displayNameForProvider(input.provider)} is unavailable.`;
    return {
      provider: input.provider,
      configured: true,
      status: "unavailable",
      reason: message
    };
  }

  return {
    provider: input.provider,
    configured: true,
    status: "available"
  };
}

function defaultCommandForProvider(provider: CodingAgentProviderId): string {
  if (provider === "gemini-cli") {
    return "gemini";
  }
  if (provider === "claude-code") {
    return "claude";
  }
  return "agent";
}

function displayNameForProvider(provider: CodingAgentProviderId): string {
  if (provider === "gemini-cli") {
    return "Gemini CLI";
  }
  if (provider === "claude-code") {
    return "Claude Code";
  }
  if (provider === "cursor") {
    return "Cursor CLI";
  }
  return "Coding agent";
}

function isCodingAgentErrorLike(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

export { createCodingAgentError };
