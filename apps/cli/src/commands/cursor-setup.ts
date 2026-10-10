import {
  findProjectConfigFile,
  formatMcpLaunchSummary,
  inspectCursorMcpSetup,
  resolveLocalRuntime,
  writeCursorMcpSetup
} from "@pairmesh/client";
import { relative } from "node:path";
import { flagValue } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";

function hasFlag(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

export async function runCursorSetupCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const bin = cliBinaryLabel();
  const configPath = await findProjectConfigFile(workspace);
  if (!configPath) {
    throw new Error(`Aroko is not initialized for this project. Run: ${bin} init --workspace .`);
  }

  const runtime = await resolveLocalRuntime({ configFilePath: configPath });
  const projectName = runtime.workspaceBasename;
  const inspection = await inspectCursorMcpSetup(runtime.workspace);
  const targetRelative = relative(runtime.workspace, inspection.targetPath) || ".cursor/mcp.json";
  const write = hasFlag(flags, "write");
  const force = hasFlag(flags, "force");

  console.log("Cursor MCP setup");
  console.log("");
  console.log(`Project: ${projectName}`);
  console.log(`Target: ${targetRelative}`);
  console.log("");

  if (inspection.status === "invalid") {
    console.log("Cannot update .cursor/mcp.json because it contains invalid JSON.");
    console.log("");
    console.log("Fix the file and retry:");
    console.log("");
    console.log(`  ${bin} cursor setup --write`);
    process.exitCode = 1;
    return;
  }

  if (inspection.status === "configured") {
    console.log("Aroko is already configured.");
    console.log("");
    console.log("Proposed MCP server:");
    console.log("");
    console.log(formatMcpLaunchSummary(inspection.proposed));
    if (write) {
      const result = await writeCursorMcpSetup({
        workspace: runtime.workspace,
        force,
        write: true
      });
      console.log("");
      console.log(result.message);
    }
    return;
  }

  if (inspection.status === "conflict" && !force) {
    const current = inspection.current;
    console.log("Aroko MCP configuration already exists.");
    console.log("");
    console.log("Current:");
    console.log(`  command: ${current?.command ?? "(missing)"}`);
    if (current?.args?.length) {
      console.log(`  args: ${current.args.join(" ")}`);
    }
    if (current?.cwd) {
      console.log(`  cwd: ${current.cwd}`);
    }
    console.log("");
    console.log("Proposed:");
    console.log("");
    console.log(formatMcpLaunchSummary(inspection.proposed));
    console.log("");
    console.log("Use --force to replace the existing Aroko entry.");
    if (write) {
      process.exitCode = 1;
    }
    return;
  }

  if (inspection.status === "missing") {
    console.log("Aroko is not configured.");
    console.log("");
    console.log("Proposed MCP server:");
    console.log("");
    console.log(formatMcpLaunchSummary(inspection.proposed));
    console.log("");
    if (write) {
      const result = await writeCursorMcpSetup({
        workspace: runtime.workspace,
        force,
        write: true
      });
      console.log(result.message);
      return;
    }
    console.log("Run:");
    console.log("");
    console.log(`  ${bin} cursor setup --write`);
    console.log("");
    console.log("to apply this configuration.");
    return;
  }

  if (write) {
    const result = await writeCursorMcpSetup({ workspace: runtime.workspace, force, write: true });
    console.log(result.message);
  }
}
