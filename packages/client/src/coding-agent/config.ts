import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createCodingAgentError,
  type BuiltInCodingAgentProviderId,
  type CodingAgentAdapterOptions
} from "./types.js";
import { isBuiltInCodingAgentProviderId } from "./descriptors.js";
import {
  applyResolvedLocalRuntimeToEnv,
  resolveLocalRuntime,
  type ResolvedLocalRuntime
} from "../local-config/resolver.js";

export interface LocalCodingAgentConfig {
  provider: BuiltInCodingAgentProviderId;
  workspace: string;
  mode: "ask" | "plan" | "agent";
  timeoutMs: number;
  fakeAgentDelayMs: number;
  /** Executable for the selected provider (cursor → agent, gemini-cli → gemini). */
  command: string;
  args: string[];
  /** @deprecated Prefer `command`. Kept for Cursor-era callers. */
  cursorCommand: string;
  /** @deprecated Prefer `args`. */
  cursorArgs: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function loadLocalCodingAgentConfigFromEnv(): Promise<LocalCodingAgentConfig> {
  const runtime = await tryResolveLocalRuntime();
  if (runtime) {
    applyResolvedLocalRuntimeToEnv(runtime);
  }

  const provider = parseProvider(process.env.PAIRMESH_CODING_AGENT_PROVIDER);
  const workspace = resolveWorkspace(process.env.PAIRMESH_WORKSPACE);
  const mode = parseMode(process.env.PAIRMESH_CODING_AGENT_MODE);
  const timeoutMs = parseTimeout(process.env.PAIRMESH_CODING_AGENT_TIMEOUT_MS);
  const fakeAgentDelayMs = parseOptionalDelay(process.env.PAIRMESH_FAKE_AGENT_DELAY_MS);
  const { command, args } = resolveProviderCommand(provider);

  if (provider !== "fake") {
    await assertWorkspaceExists(workspace);
  }

  return {
    provider,
    workspace,
    mode,
    timeoutMs,
    fakeAgentDelayMs,
    command,
    args,
    cursorCommand: command,
    cursorArgs: args
  };
}

async function tryResolveLocalRuntime(): Promise<ResolvedLocalRuntime | null> {
  if (process.env.PAIRMESH_WORKSPACE?.trim() && process.env.PAIRMESH_STATE_FILE?.trim()) {
    return null;
  }

  try {
    return await resolveLocalRuntime();
  } catch {
    return null;
  }
}

export function toAdapterOptions(config: LocalCodingAgentConfig): CodingAgentAdapterOptions {
  return {
    workspace: config.workspace,
    mode: config.mode,
    timeoutMs: config.timeoutMs,
    command: config.command,
    args: config.args
  };
}

function parseProvider(value: string | undefined): BuiltInCodingAgentProviderId {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "cursor") {
    return "cursor";
  }
  if (!isBuiltInCodingAgentProviderId(normalized)) {
    throw createCodingAgentError("agent_misconfigured", "Unsupported coding agent provider.", {
      provider: value
    });
  }
  return normalized;
}

function resolveProviderCommand(provider: BuiltInCodingAgentProviderId): {
  command: string;
  args: string[];
} {
  if (provider === "gemini-cli") {
    const command = process.env.PAIRMESH_GEMINI_COMMAND?.trim() || "gemini";
    const args = parseArgs(process.env.PAIRMESH_GEMINI_ARGS) ?? [];
    return { command, args };
  }

  if (provider === "claude-code") {
    const command = process.env.PAIRMESH_CLAUDE_COMMAND?.trim() || "claude";
    const args = parseArgs(process.env.PAIRMESH_CLAUDE_ARGS) ?? [];
    return { command, args };
  }

  if (provider === "fake") {
    return { command: "fake", args: [] };
  }

  const command = process.env.PAIRMESH_CURSOR_COMMAND?.trim() || "agent";
  const args = parseArgs(process.env.PAIRMESH_CURSOR_ARGS) ?? ["acp"];
  return { command, args };
}

function parseMode(value: string | undefined): LocalCodingAgentConfig["mode"] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "ask") {
    return "ask";
  }
  if (normalized === "plan" || normalized === "agent") {
    return normalized;
  }
  throw createCodingAgentError("agent_misconfigured", "Unsupported coding agent mode.", {
    mode: value
  });
}

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createCodingAgentError("agent_misconfigured", "Invalid coding agent timeout.", {
      timeoutMs: value
    });
  }
  return parsed;
}

function parseOptionalDelay(value: string | undefined): number {
  if (!value?.trim()) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function parseArgs(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value.split(/\s+/).filter(Boolean);
}

function resolveWorkspace(value: string | undefined): string {
  const workspace = value?.trim();
  if (!workspace) {
    throw createCodingAgentError(
      "agent_misconfigured",
      "PAIRMESH_WORKSPACE is required for coding-agent inspection."
    );
  }
  return resolve(workspace);
}

async function assertWorkspaceExists(workspace: string): Promise<void> {
  try {
    await access(workspace);
  } catch {
    throw createCodingAgentError("agent_misconfigured", "Configured workspace does not exist.", {
      field: "PAIRMESH_WORKSPACE"
    });
  }
}
