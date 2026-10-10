import { findProjectConfigFile, installClaudeReceiverAwareness } from "@pairmesh/client";
import { flagValue } from "../args.js";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";

function hasFlag(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

export async function runClaudeSetupCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const configPath = await findProjectConfigFile(workspace);
  const bin = cliBinaryLabel();
  if (!configPath) {
    throw new Error(
      `${productDisplayName()} is not initialized for this project. Run: ${bin} init --workspace .`
    );
  }

  const write = hasFlag(flags, "write");
  const force = hasFlag(flags, "force");
  const result = await installClaudeReceiverAwareness({ workspace, write, force });

  console.log(`Claude Code — ${productDisplayName()} receiver awareness`);
  console.log("");
  if (!result.supported) {
    console.log(result.message);
    process.exitCode = 1;
    return;
  }
  console.log(result.message);
  if (!write) {
    console.log("");
    console.log(`  ${bin} claude setup --write`);
  } else {
    console.log("");
    console.log("MCP tools (receiver): list_requests / show_request / show_proposal / open_inbox");
    console.log("Approval stays in local Control Inbox only — no MCP approve tool.");
  }
}
