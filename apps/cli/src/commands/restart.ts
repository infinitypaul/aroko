import { computeRuntimeMetadata, readRuntimeInfo } from "@pairmesh/client";
import { flagValue } from "../args.js";
import { productDisplayName } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import {
  resolveRuntimeForStart,
  startBackgroundRuntime,
  stopBackgroundRuntime
} from "../runtime/background-runtime.js";

export async function runRestartCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const bindHost = flagValue(flags, "host");
  const previousRuntime = await readRuntimeInfo(workspace);
  const previousPort = previousRuntime?.port;
  const product = productDisplayName();

  let hadActiveSession = false;
  try {
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    const status = await manager.getSessionStatus();
    hadActiveSession = status.status === "active" && status.peers.length > 0;
  } catch {
    hadActiveSession = false;
  }

  await stopBackgroundRuntime({ workspace, force: flags.force === "true" });

  const runtime = await resolveRuntimeForStart({
    workspace,
    bindHost,
    preservePort: true
  });

  if (hadActiveSession && previousPort !== undefined && runtime.port !== previousPort) {
    console.warn(
      `Warning: ${product} selected a different port on restart. Peers may still reference the previous endpoint.`
    );
    console.warn(`Previous port: ${previousPort}`);
    console.warn(`Current port: ${runtime.port}`);
    console.warn("");
  }

  const result = await startBackgroundRuntime(runtime);
  const runtimeMeta = computeRuntimeMetadata({
    bindHost: runtime.host,
    port: runtime.port,
    advertise: runtime.config.agent.advertise
  });

  console.log(`${product} restarted`);
  console.log("");
  console.log(`Agent: ${runtime.agentName}`);
  console.log(`Project: ${runtime.workspaceBasename}`);
  console.log(`A2A: ${runtimeMeta.baseUrl}`);
  console.log(`Health: ${result.healthLabel}`);
  console.log(`PID: ${result.pid}`);
}
