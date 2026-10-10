import type { BuiltInCodingAgentProviderId, CodingAgentProviderDescriptor } from "./types.js";
import { CODING_AGENT_OWNER_VISIBILITY } from "./provider-visibility.js";

export const CURSOR_PROVIDER: CodingAgentProviderDescriptor = {
  id: "cursor",
  displayName: "Cursor Agent",
  capabilities: {
    inspect: true,
    followUp: true,
    sourceReferences: true,
    cancellation: true,
    nativeSessionResume: true,
        proposeChange: true
  },
  ownerVisibility: CODING_AGENT_OWNER_VISIBILITY.cursor
};

export const GEMINI_CLI_PROVIDER: CodingAgentProviderDescriptor = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  capabilities: {
    inspect: true,
    followUp: true,
    sourceReferences: true,
    cancellation: true,
    nativeSessionResume: false,
    proposeChange: false
  },
  ownerVisibility: CODING_AGENT_OWNER_VISIBILITY["gemini-cli"]
};

export const CLAUDE_CODE_PROVIDER: CodingAgentProviderDescriptor = {
  id: "claude-code",
  displayName: "Claude Code",
  capabilities: {
    inspect: true,
    followUp: true,
    sourceReferences: true,
    cancellation: true,
    nativeSessionResume: false,
        proposeChange: true
  },
  ownerVisibility: CODING_AGENT_OWNER_VISIBILITY["claude-code"]
};

export const FAKE_PROVIDER: CodingAgentProviderDescriptor = {
  id: "fake",
  displayName: "Fake Coding Agent",
  capabilities: {
    inspect: true,
    followUp: true,
    sourceReferences: true,
    cancellation: true,
    nativeSessionResume: false,
    proposeChange: true
  },
  ownerVisibility: CODING_AGENT_OWNER_VISIBILITY.fake
};

const BUILTIN: Record<BuiltInCodingAgentProviderId, CodingAgentProviderDescriptor> = {
  cursor: CURSOR_PROVIDER,
  "gemini-cli": GEMINI_CLI_PROVIDER,
  "claude-code": CLAUDE_CODE_PROVIDER,
  fake: FAKE_PROVIDER
};

export function getBuiltinProviderDescriptor(
  id: BuiltInCodingAgentProviderId
): CodingAgentProviderDescriptor {
  return BUILTIN[id];
}

export function isBuiltInCodingAgentProviderId(
  value: string
): value is BuiltInCodingAgentProviderId {
  return (
    value === "cursor" || value === "gemini-cli" || value === "claude-code" || value === "fake"
  );
}
