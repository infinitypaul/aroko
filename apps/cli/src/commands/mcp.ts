import {
  findProjectConfigFile,
  formatMcpLaunchSummary,
  resolveGuiSafeInstalledMcpLaunchConfig,
  resolveLocalRuntime,
  resolveMcpLaunchConfig,
  validateMcpLaunchConfig,
  type McpLaunchConfig
} from "@pairmesh/client";
import { runPairMeshMcpStdio } from "@pairmesh/mcp/context";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { flagValue } from "../args.js";
import { resolveCommandWorkspace } from "../workspace.js";

function hasFlag(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

export async function runMcpCommand(flags: Record<string, string> = {}): Promise<void> {
  if (hasFlag(flags, "check")) {
    await runMcpCheckCommand(flags);
    return;
  }

  if (hasFlag(flags, "print-config")) {
    await runMcpPrintConfigCommand(flags);
    return;
  }

  await runPairMeshMcpStdio();
}

async function runMcpCheckCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const configPath = await findProjectConfigFile(workspace);
  if (!configPath) {
    throw new Error("Aroko is not initialized for this project. Run: aroko init --workspace .");
  }

  const runtime = await resolveLocalRuntime({ configFilePath: configPath });
  const launch = await resolveMcpLaunchConfig({ workspace: runtime.workspace });
  await validateMcpLaunchConfig(launch);

  console.error("Aroko MCP launch config OK");
  console.error(formatMcpLaunchSummary(launch));
}

/**
 * Setup-only helper: print a client-specific MCP config fragment for the current project.
 * No secrets. Does not write Claude/Cursor config files unless the operator copies them.
 */
async function runMcpPrintConfigCommand(flags: Record<string, string>): Promise<void> {
  const client = (flagValue(flags, "client") ?? "claude-desktop").trim().toLowerCase();
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const configPath = await findProjectConfigFile(workspace);
  if (!configPath) {
    throw new Error("Aroko is not initialized for this project. Run: aroko init --workspace .");
  }

  const runtime = await resolveLocalRuntime({ configFilePath: configPath });
  const launch = await resolveGuiSafeLaunchForPrint(runtime.workspace);
  await validateMcpLaunchConfig(launch);

  if (client === "claude-desktop" || client === "claude") {
    const fragment = {
      mcpServers: {
        aroko: {
          command: launch.command,
          args: launch.args,
          env: launch.env ?? {
            AROKO_PROJECT_ROOT: runtime.workspace,
            PAIRMESH_PROJECT_ROOT: runtime.workspace
          }
        }
      }
    };
    console.log(JSON.stringify(fragment, null, 2));
    console.error("");
    console.error("Claude Desktop (local stdio MCP only — not remote connectors):");
    console.error(
      `  macOS config: ${resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")}`
    );
    console.error(
      "  Merge the mcpServers.aroko entry above, then fully quit and reopen Claude Desktop."
    );
    console.error(`  AROKO_PROJECT_ROOT / PAIRMESH_PROJECT_ROOT → ${runtime.workspace}`);
    console.error("  Do not put bearers, invite secrets, or control tokens in this file.");
    return;
  }

  if (client === "cursor" || client === "generic") {
    const fragment = {
      mcpServers: {
        aroko: {
          type: "stdio" as const,
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd ?? ".",
          env: launch.env ?? {
            AROKO_PROJECT_ROOT: runtime.workspace,
            PAIRMESH_PROJECT_ROOT: runtime.workspace
          }
        }
      }
    };
    console.log(JSON.stringify(fragment, null, 2));
    console.error("");
    console.error(
      client === "cursor"
        ? "Cursor: merge into <project>/.cursor/mcp.json (or run: aroko cursor setup --write)."
        : "Generic stdio MCP host: use command/args/env as printed."
    );
    return;
  }

  throw new Error(`Unsupported --client ${client}. Use claude-desktop, cursor, or generic.`);
}

async function resolveGuiSafeLaunchForPrint(workspace: string): Promise<McpLaunchConfig> {
  const nodeBin = process.env.PAIRMESH_NODE_BIN?.trim() || process.execPath;
  const cliEntryCandidates = [
    process.env.PAIRMESH_CLI_ENTRY?.trim(),
    process.argv[1],
    resolve(homedir(), ".local/lib/node_modules/@pairmesh/cli/dist/index.js")
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of cliEntryCandidates) {
    const absolute = resolve(candidate);
    try {
      await access(absolute);
      return resolveGuiSafeInstalledMcpLaunchConfig({
        workspace,
        nodeBin,
        cliEntryPath: absolute
      });
    } catch {
      // try next
    }
  }

  return resolveMcpLaunchConfig({ workspace, mode: "installed" });
}
