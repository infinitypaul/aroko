import {
  applyResolvedLocalRuntimeToEnv,
  computeRuntimeMetadata,
  resolveLocalRuntime
} from "@pairmesh/client";
import { flagValue } from "../args.js";
import { resolveCommandWorkspace } from "../workspace.js";
import { resolveRuntimeForStart, startBackgroundRuntime } from "../runtime/background-runtime.js";
import { runForegroundRuntime } from "../runtime/foreground-runtime.js";

function isForeground(flags: Record<string, string>): boolean {
  return flags.foreground === "true" || flags.f === "true";
}

export async function runStartCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const bindHost = flagValue(flags, "host");
  const verbose = flags.verbose === "true";

  const delayRaw = process.env.PAIRMESH_START_AFTER_MS?.trim();
  if (delayRaw) {
    const delayMs = Number(delayRaw);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (isForeground(flags)) {
    const runtime = await resolveLocalRuntime({
      cwd: workspace,
      cli: { workspace, bindHost }
    });
    console.log("Aroko starting...");
    console.log("");
    await runForegroundRuntime({ runtime, mode: "foreground", verbose });
    return;
  }

  const runtime = await resolveRuntimeForStart({
    workspace,
    bindHost,
    preservePort: true
  });
  applyResolvedLocalRuntimeToEnv(runtime);

  const result = await startBackgroundRuntime(runtime);
  const runtimeMeta = computeRuntimeMetadata({
    bindHost: runtime.host,
    port: runtime.port,
    advertise: runtime.config.agent.advertise
  });

  if (result.upgradeOutcome) {
    const { formatUpgradeUx } = await import("../runtime/upgrade-handshake.js");
    const message = formatUpgradeUx(result.upgradeOutcome);
    if (message) {
      console.log(message);
      console.log("");
    }
    if (result.upgradeOutcome.kind === "deferred" && result.alreadyRunning) {
      console.log("Aroko is running.");
      console.log("");
      console.log(`Agent: ${runtime.agentName}`);
      console.log(`A2A: ${runtimeMeta.baseUrl}`);
      console.log(`PID: ${result.pid}`);
      return;
    }
    if (result.upgradeOutcome.kind === "updated") {
      console.log("Aroko started");
      console.log("");
      console.log(`Agent: ${runtime.agentName}`);
      console.log(`Project: ${runtime.workspaceBasename}`);
      console.log(`A2A: ${runtimeMeta.baseUrl}`);
      console.log(`Health: ${result.healthLabel}`);
      console.log(`PID: ${result.pid}`);
      return;
    }
  }

  if (result.alreadyRunning) {
    console.log("Aroko is running.");
    console.log("");
    console.log(`Agent: ${runtime.agentName}`);
    console.log(`A2A: ${runtimeMeta.baseUrl}`);
    console.log(`PID: ${result.pid}`);
    return;
  }

  console.log("Aroko started");
  console.log("");
  console.log(`Agent: ${runtime.agentName}`);
  console.log(`Project: ${runtime.workspaceBasename}`);
  console.log(`A2A: ${runtimeMeta.baseUrl}`);
  console.log(`Health: ${result.healthLabel}`);
  console.log(`PID: ${result.pid}`);
}
