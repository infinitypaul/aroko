import {
  PAIRMESH_HOST_REQUEST_TOOLS,
  RequestChangeProposalArgsSchema,
  RequestProcessExecutionArgsSchema,
  RequestRepositoryEditArgsSchema,
  RequestRequesterInputArgsSchema,
  RequestTestsRunArgsSchema,
  createPairMeshError,
  type PairMeshHostRequestToolName
} from "@pairmesh/protocol";

/** MCP-style namespaced aliases Claude/Cursor may emit for PairMesh host tools. */
export const PAIRMESH_GOAL_MCP_TOOL_PREFIX = "mcp__pairmesh_goal__" as const;

export interface GoalHostToolDefinition {
  name: PairMeshHostRequestToolName;
  description: string;
  /** JSON Schema (draft-07 style) matching R5-4 strict Zod schemas. */
  inputSchema: Record<string, unknown>;
}

export const PAIRMESH_GOAL_HOST_TOOLS: readonly GoalHostToolDefinition[] = [
  {
    name: "request_requester_input",
    description:
      "Ask the remote requester a clarification question. Creates an InputRequest — not an Action and not approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2048 },
        options: {
          type: "array",
          maxItems: 6,
          items: { type: "string", minLength: 1, maxLength: 200 }
        },
        allowFreeText: { type: "boolean" }
      }
    }
  },
  {
    name: "request_change_proposal",
    description:
      "Request a change.propose Action on the receiver. Owner must Approve once — this call does not approve.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["instruction"],
      properties: {
        instruction: { type: "string", minLength: 1, maxLength: 8000 }
      }
    }
  },
  {
    name: "request_repository_edit",
    description:
      "Request repository.edit for a prior proposal artifact. Requires artifactId + contentHash. Does not approve.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId", "contentHash"],
      properties: {
        artifactId: { type: "string", minLength: 1, maxLength: 80 },
        contentHash: {
          type: "string",
          pattern: "^[a-f0-9]{64}$"
        }
      }
    }
  },
  {
    name: "request_tests_run",
    description: "Request tests.run for a receiver-defined profile. Does not approve or execute.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["profileName"],
      properties: {
        profileName: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$"
        }
      }
    }
  },
  {
    name: "request_process_execution",
    description:
      "Request process.execute with structured argv (shell=false; no shell hosts). Owner must Approve once. Never pass a command string. Approved programs run as the receiver OS user — not a sandbox; interpreters can still execute code.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["executable", "args"],
      properties: {
        executable: { type: "string", minLength: 1, maxLength: 200 },
        args: {
          type: "array",
          maxItems: 64,
          items: { type: "string", maxLength: 2000 }
        },
        cwd: { type: "string", minLength: 1, maxLength: 500 },
        timeoutMs: { type: "integer", exclusiveMinimum: 0, maximum: 3_600_000 }
      }
    }
  }
] as const;

export function normalizeHostToolName(rawName: string): PairMeshHostRequestToolName | null {
  const trimmed = rawName.trim();
  if ((PAIRMESH_HOST_REQUEST_TOOLS as readonly string[]).includes(trimmed)) {
    return trimmed as PairMeshHostRequestToolName;
  }
  if (trimmed.startsWith(PAIRMESH_GOAL_MCP_TOOL_PREFIX)) {
    const suffix = trimmed.slice(PAIRMESH_GOAL_MCP_TOOL_PREFIX.length);
    if ((PAIRMESH_HOST_REQUEST_TOOLS as readonly string[]).includes(suffix)) {
      return suffix as PairMeshHostRequestToolName;
    }
  }
  // Gemini CLI FQN: mcp_{server}_{tool} (server may be pairmesh-goal or pairmesh_goal)
  if (trimmed.startsWith("mcp_")) {
    for (const tool of PAIRMESH_HOST_REQUEST_TOOLS) {
      if (
        trimmed === `mcp_pairmesh-goal_${tool}` ||
        trimmed === `mcp_pairmesh_goal_${tool}` ||
        trimmed.endsWith(`_${tool}`)
      ) {
        // Prefer exact host tool suffix match after last underscore segment join.
        const idx = trimmed.lastIndexOf(`_${tool}`);
        if (idx > 0 && trimmed.slice(idx + 1) === tool) {
          return tool;
        }
      }
    }
  }
  // Cursor ACP permission titles:
  // "pairmesh_goal-request_requester_input: request_requester_input"
  const colonSuffix = trimmed.includes(": ")
    ? trimmed.slice(trimmed.lastIndexOf(": ") + 2).trim()
    : undefined;
  if (colonSuffix && (PAIRMESH_HOST_REQUEST_TOOLS as readonly string[]).includes(colonSuffix)) {
    return colonSuffix as PairMeshHostRequestToolName;
  }
  for (const tool of PAIRMESH_HOST_REQUEST_TOOLS) {
    if (
      trimmed === tool ||
      trimmed.endsWith(`__${tool}`) ||
      trimmed.endsWith(`-${tool}`) ||
      trimmed.includes(`-${tool}:`) ||
      trimmed.includes(`__${tool}`)
    ) {
      return tool;
    }
  }
  return null;
}

export type ParseHostToolCallResult =
  | { ok: true; toolName: PairMeshHostRequestToolName; args: unknown }
  | { ok: false; code: "pairmesh.host_tool_invalid"; message: string; details?: unknown };

function rejectCommandStringProcessArgs(args: unknown): ParseHostToolCallResult | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const record = args as Record<string, unknown>;
  if ("command" in record || "shell" in record || "cmd" in record || "script" in record) {
    return {
      ok: false,
      code: "pairmesh.host_tool_invalid",
      message:
        "request_process_execution rejects command-string / shell process schemas; use executable + args only.",
      details: {
        forbiddenKeys: Object.keys(record).filter((k) =>
          ["command", "shell", "cmd", "script"].includes(k)
        )
      }
    };
  }
  return null;
}

/**
 * Parse and validate a host tool invocation from a provider tool_use / tool_call.
 * Rejects unknown tools, unknown fields (via Zod strict), and command-string process schemas.
 */
export function parseHostToolCall(name: string, args: unknown): ParseHostToolCallResult {
  const toolName = normalizeHostToolName(name);
  if (!toolName) {
    return {
      ok: false,
      code: "pairmesh.host_tool_invalid",
      message: `Unknown PairMesh host request tool: ${name}`,
      details: { name, allowed: [...PAIRMESH_HOST_REQUEST_TOOLS] }
    };
  }

  if (toolName === "request_process_execution") {
    const commandReject = rejectCommandStringProcessArgs(args);
    if (commandReject) {
      return commandReject;
    }
  }

  try {
    switch (toolName) {
      case "request_requester_input":
        return { ok: true, toolName, args: RequestRequesterInputArgsSchema.parse(args) };
      case "request_change_proposal":
        return { ok: true, toolName, args: RequestChangeProposalArgsSchema.parse(args) };
      case "request_repository_edit":
        return { ok: true, toolName, args: RequestRepositoryEditArgsSchema.parse(args) };
      case "request_tests_run":
        return { ok: true, toolName, args: RequestTestsRunArgsSchema.parse(args) };
      case "request_process_execution":
        return { ok: true, toolName, args: RequestProcessExecutionArgsSchema.parse(args) };
      default: {
        const _exhaustive: never = toolName;
        return {
          ok: false,
          code: "pairmesh.host_tool_invalid",
          message: `Unhandled host tool: ${String(_exhaustive)}`
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: "pairmesh.host_tool_invalid",
      message: error instanceof Error ? error.message : "Host tool args failed validation.",
      details: { toolName, error }
    };
  }
}

export function assertHostToolCall(
  name: string,
  args: unknown
): { toolName: PairMeshHostRequestToolName; args: unknown } {
  const parsed = parseHostToolCall(name, args);
  if (!parsed.ok) {
    throw createPairMeshError({
      code: parsed.code,
      message: parsed.message
    });
  }
  return { toolName: parsed.toolName, args: parsed.args };
}
