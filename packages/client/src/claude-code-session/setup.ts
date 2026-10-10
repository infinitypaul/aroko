import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ownerVisibilityForProvider,
  mayInstallReceiverSessionAwareness
} from "../coding-agent/provider-visibility.js";
import {
  resolveDefaultMcpLaunchMode,
  resolveMcpLaunchConfig,
  type McpLaunchConfig
} from "../cursor-mcp/mcp-launch.js";

export interface ClaudeReceiverSetupResult {
  supported: boolean;
  mcpPath: string;
  hooksPath: string;
  wrote: boolean;
  message: string;
}

/**
 * Install receiver-local PairMesh MCP + Claude Code lifecycle hooks.
 * Gated by shipped PairMesh receiver-session integration (claude-code today).
 * Other providers may have equivalent runtime APIs — see owner-visibility matrix.
 * Hooks register/unregister session awareness; they never approve.
 */
export async function installClaudeReceiverAwareness(input: {
  workspace: string;
  write: boolean;
  force?: boolean;
}): Promise<ClaudeReceiverSetupResult> {
  const visibility = ownerVisibilityForProvider("claude-code");
  if (!mayInstallReceiverSessionAwareness(visibility)) {
    return {
      supported: false,
      mcpPath: "",
      hooksPath: "",
      wrote: false,
      message: "Claude Code owner-visibility capabilities do not enable receiver MCP/hooks."
    };
  }

  const mode = await resolveDefaultMcpLaunchMode();
  const launch = await resolveMcpLaunchConfig({
    workspace: input.workspace,
    mode
  });

  const mcpPath = join(input.workspace, ".mcp.json");
  const hooksPath = join(input.workspace, ".claude", "pairmesh-hooks.json");
  const sessionFile = join(input.workspace, ".pairmesh", "claude-session.json");

  if (!input.write) {
    return {
      supported: true,
      mcpPath,
      hooksPath,
      wrote: false,
      message:
        `Would write receiver MCP to ${mcpPath} and hooks to ${hooksPath}. ` +
        `Run with --write to apply. AROKO_MCP_ROLE=receiver (PAIRMESH_MCP_ROLE also accepted).`
    };
  }

  await writeReceiverMcpJson(mcpPath, launch, input.workspace, Boolean(input.force));
  await writeClaudeHooks(hooksPath, sessionFile, input.workspace);
  return {
    supported: true,
    mcpPath,
    hooksPath,
    wrote: true,
    message:
      `Wrote receiver MCP (${mcpPath}) and Claude hooks (${hooksPath}). ` +
      `Restart Claude Code in this project. Tools: list/show/open only — no approve.`
  };
}

async function writeReceiverMcpJson(
  mcpPath: string,
  launch: McpLaunchConfig,
  workspace: string,
  force: boolean
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(mcpPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const servers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  if (servers.aroko && !force && !servers.pairmesh) {
    // Update env role if present
  }
  const entry = {
    command: launch.command,
    args: launch.args,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    env: {
      ...(launch.env ?? {}),
      AROKO_PROJECT_ROOT: workspace,
      PAIRMESH_PROJECT_ROOT: workspace,
      AROKO_MCP_ROLE: "receiver",
      PAIRMESH_MCP_ROLE: "receiver"
    }
  };
  servers.aroko = entry;
  delete servers.pairmesh;
  await writeFile(
    mcpPath,
    `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Build a shell-safe `node -e <source>` command.
 * Nested double quotes around path literals break Claude's hook runner
 * (`const p="/path"` inside `"..."` → SyntaxError: Invalid regular expression flags).
 * JSON.stringify the whole eval source so the shell sees one correctly quoted arg.
 */
export function nodeEvalCommand(source: string): string {
  return `node -e ${JSON.stringify(source)}`;
}

async function writeClaudeHooks(
  hooksPath: string,
  sessionFile: string,
  workspace: string
): Promise<void> {
  await mkdir(dirname(hooksPath), { recursive: true });
  await mkdir(dirname(sessionFile), { recursive: true });

  // command hooks: register on SessionStart, clear on SessionEnd.
  // Reminder on Stop — observational only (no approve).
  const registerCmd = nodeEvalCommand(
    `const fs=require('fs');const p=${JSON.stringify(sessionFile)};fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify({registeredAt:new Date().toISOString(),workspace:${JSON.stringify(workspace)},provider:'claude-code'},null,2));`
  );

  const unregisterCmd = nodeEvalCommand(
    `const fs=require('fs');try{fs.unlinkSync(${JSON.stringify(sessionFile)})}catch{}`
  );

  const reminderCmd = nodeEvalCommand(
    `const fs=require('fs');const p=${JSON.stringify(sessionFile)};if(fs.existsSync(p)){console.log('PairMesh: session registered. Ask about PairMesh requests (list/show/open only - decisions stay in local Inbox).')}`
  );

  const hooks = {
    description:
      "PairMesh Stage 16 receiver awareness — SessionStart/End registration; Stop reminder. No approval authority.",
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: registerCmd }]
        }
      ],
      SessionEnd: [
        {
          hooks: [{ type: "command", command: unregisterCmd }]
        }
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: reminderCmd }]
        }
      ]
    }
  };

  await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");

  // Merge pointer into .claude/settings.json if present / create minimal
  const settingsPath = join(workspace, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  // Claude Code reads hooks from settings.hooks or project hooks files depending on version.
  // Document both: embed hooks inline for reliability.
  settings.hooks = (hooks as { hooks: unknown }).hooks;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function isClaudeSessionRegistered(workspace: string): Promise<boolean> {
  const sessionFile = join(workspace, ".pairmesh", "claude-session.json");
  return readFile(sessionFile, "utf8")
    .then(() => true)
    .catch(() => false);
}
