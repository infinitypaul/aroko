#!/usr/bin/env node
import { openRuntimeLogHandles, resolveLocalRuntime } from "@pairmesh/client";
import { runForegroundRuntime } from "./foreground-runtime.js";

async function main(): Promise<void> {
  const workspace = process.env.PAIRMESH_PROJECT_ROOT?.trim();
  if (!workspace) {
    console.error("PAIRMESH_PROJECT_ROOT is required for runtime worker.");
    process.exit(1);
  }

  const logs = await openRuntimeLogHandles(workspace);
  const runtime = await resolveLocalRuntime({
    cwd: workspace,
    cli: { workspace }
  });

  await runForegroundRuntime({
    runtime,
    mode: "background",
    logFile: logs.logFile
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
