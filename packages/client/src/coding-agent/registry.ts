import { CursorAcpAdapter } from "./cursor-adapter.js";
import { FakeCodingAgentAdapter } from "./fake-adapter.js";
import { GeminiCliAdapter } from "./gemini-cli-adapter.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { getBuiltinProviderDescriptor, isBuiltInCodingAgentProviderId } from "./descriptors.js";
import {
  createCodingAgentError,
  type BuiltInCodingAgentProviderId,
  type CodingAgentAdapter,
  type CodingAgentAdapterOptions,
  type CodingAgentProviderId
} from "./types.js";

export type CodingAgentAdapterFactory = (options: CodingAgentAdapterOptions) => CodingAgentAdapter;

const factories = new Map<CodingAgentProviderId, CodingAgentAdapterFactory>([
  ["cursor", (options) => new CursorAcpAdapter(options)],
  ["fake", (options) => new FakeCodingAgentAdapter(options.workspace)],
  [
    "gemini-cli",
    (options) =>
      new GeminiCliAdapter({
        workspace: options.workspace,
        timeoutMs: options.timeoutMs,
        command: options.command,
        args: options.args
      })
  ],
  [
    "claude-code",
    (options) =>
      new ClaudeCodeAdapter({
        workspace: options.workspace,
        timeoutMs: options.timeoutMs,
        command: options.command,
        args: options.args
      })
  ]
]);

/**
 * Resolve a coding-agent adapter by provider id.
 * Provider-specific branching stays here — not in A2A/MCP/authz.
 */
export function createCodingAgentAdapter(
  provider: CodingAgentProviderId,
  options: CodingAgentAdapterOptions
): CodingAgentAdapter {
  const factory = factories.get(provider);
  if (!factory) {
    throw createCodingAgentError("agent_misconfigured", "Unsupported coding agent provider.", {
      provider
    });
  }
  return factory(options);
}

export function registerCodingAgentProvider(
  providerId: CodingAgentProviderId,
  factory: CodingAgentAdapterFactory
): void {
  if (!providerId.trim()) {
    throw createCodingAgentError("agent_misconfigured", "Provider id must be non-empty.");
  }
  factories.set(providerId, factory);
}

export function listRegisteredCodingAgentProviders(): CodingAgentProviderId[] {
  return [...factories.keys()];
}

export function requireBuiltInProvider(provider: string): BuiltInCodingAgentProviderId {
  const normalized = provider.trim().toLowerCase();
  if (!isBuiltInCodingAgentProviderId(normalized)) {
    throw createCodingAgentError("agent_misconfigured", "Unsupported coding agent provider.", {
      provider
    });
  }
  return normalized;
}

export function describeRegisteredProvider(
  provider: CodingAgentProviderId
): ReturnType<typeof getBuiltinProviderDescriptor> | undefined {
  if (isBuiltInCodingAgentProviderId(provider)) {
    return getBuiltinProviderDescriptor(provider);
  }
  return undefined;
}
