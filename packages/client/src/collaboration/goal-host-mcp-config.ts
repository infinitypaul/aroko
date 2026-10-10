/**
 * Resolve Claude `--mcp-config` / Cursor ACP `mcpServers` entries for the
 * PairMesh goal-mode host-tool MCP (structured request_* only).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAIRMESH_GOAL_HOST_TOOLS } from "./goal-host-tools.js";

export const PAIRMESH_GOAL_MCP_SERVER_NAME = "pairmesh_goal" as const;

/**
 * Absolute path to the goal host MCP entry.
 * Prefer compiled dist `.js` (Claude MCP stdio is unreliable with node --import tsx).
 * Fall back to same-dir `.js`, then `.ts` for local source-only runs.
 */
export function resolveGoalHostMcpStdioEntry(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // When imported from src/ via tsx, still prefer built dist for the MCP child.
    join(dir, "..", "..", "dist", "collaboration", "goal-host-mcp-stdio.js"),
    join(dir, "goal-host-mcp-stdio.js"),
    join(dir, "goal-host-mcp-stdio.ts")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export interface GoalHostMcpLaunch {
  name: typeof PAIRMESH_GOAL_MCP_SERVER_NAME;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildGoalHostMcpLaunch(nodeExecutable = process.execPath): GoalHostMcpLaunch {
  const entry = resolveGoalHostMcpStdioEntry();
  if (entry.endsWith(".ts")) {
    return {
      name: PAIRMESH_GOAL_MCP_SERVER_NAME,
      command: nodeExecutable,
      args: ["--import", "tsx", entry],
      env: {}
    };
  }
  return {
    name: PAIRMESH_GOAL_MCP_SERVER_NAME,
    command: nodeExecutable,
    args: [entry],
    env: {}
  };
}

/** Claude Code `--mcp-config` JSON object. */
export function buildClaudeGoalMcpConfigObject(
  launch: GoalHostMcpLaunch = buildGoalHostMcpLaunch()
): {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
} {
  return {
    mcpServers: {
      [launch.name]: {
        command: launch.command,
        args: launch.args,
        ...(Object.keys(launch.env).length > 0 ? { env: launch.env } : {})
      }
    }
  };
}

/**
 * Write a disposable Claude mcp-config JSON file. Returns absolute path.
 */
export function writeClaudeGoalMcpConfigFile(
  targetPath: string,
  launch: GoalHostMcpLaunch = buildGoalHostMcpLaunch()
): string {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    `${JSON.stringify(buildClaudeGoalMcpConfigObject(launch), null, 2)}\n`,
    "utf8"
  );
  return targetPath;
}

/**
 * Cursor ACP `session/new` mcpServers array entry (stdio).
 * Agent Client Protocol (@agentclientprotocol/sdk) requires:
 *   { name, command, args, env: [{ name, value }, ...] }
 * A record-shaped `env` fails Zod parse and surfaces as "Internal error".
 */
export function buildCursorGoalAcpMcpServers(
  launch: GoalHostMcpLaunch = buildGoalHostMcpLaunch()
): Array<{
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}> {
  return [
    {
      name: launch.name,
      command: launch.command,
      args: launch.args,
      env: Object.entries(launch.env).map(([name, value]) => ({ name, value }))
    }
  ];
}

/** Claude `--allowedTools` list including read-only builtins + host MCP tools. */
export function buildClaudeGoalAllowedTools(): string {
  const mcpTools = PAIRMESH_GOAL_HOST_TOOLS.map(
    (tool) => `mcp__${PAIRMESH_GOAL_MCP_SERVER_NAME}__${tool.name}`
  );
  return ["Read", "Grep", "Glob", ...mcpTools].join(",");
}
