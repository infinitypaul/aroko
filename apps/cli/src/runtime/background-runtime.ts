import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyResolvedLocalRuntimeToEnv,
  clearDeferredRestart,
  clearRuntimeInfo,
  inspectManagedRuntime,
  openRuntimeLogHandles,
  PAIRMESH_BUILD_ID,
  readDeferredRestart,
  readRuntimeInfo,
  resolveLocalRuntime,
  waitForRuntimeReady,
  type ResolvedLocalRuntime
} from "@pairmesh/client";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";
import { formatHealthLabel } from "../runtime/foreground-runtime.js";

export interface BackgroundStartResult {
  runtime: ResolvedLocalRuntime;
  pid: number;
  healthLabel: string;
  alreadyRunning: boolean;
    upgradeOutcome?: import("./upgrade-handshake.js").UpgradeHandshakeOutcome;
}

function resolveWorkerLaunch(): { command: string; args: string[]; cwd: string } {
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = join(runtimeDir, "..", "..");
  // Prefer compiled worker: vitest loads `src/`, so a sibling `worker.js` may be
  // absent even when `dist/runtime/worker.js` exists. Avoid tsx when possible —
  // some hosts block tsx IPC sockets (EPERM).
  const workerCandidates = [join(runtimeDir, "worker.js"), join(cliRoot, "dist/runtime/worker.js")];
  for (const distWorker of workerCandidates) {
    if (existsSync(distWorker)) {
      return { command: process.execPath, args: [distWorker], cwd: cliRoot };
    }
  }

  const monorepoRoot = process.env.PAIRMESH_DEV_ROOT?.trim() || join(cliRoot, "..", "..");
  const tsxBin = join(monorepoRoot, "node_modules", ".bin", "tsx");
  const srcWorker = join(runtimeDir, "worker.ts");
  return {
    command: tsxBin,
    args: [srcWorker],
    cwd: monorepoRoot
  };
}

export async function startBackgroundRuntime(
  runtime: ResolvedLocalRuntime,
  options: { skipUpgradeHandshake?: boolean } = {}
): Promise<BackgroundStartResult> {
  const existing = await readRuntimeInfo(runtime.workspace);
  const inspection = await inspectManagedRuntime(runtime.workspace, runtime.config, existing);
  if (inspection.verified && existing) {
    if (options.skipUpgradeHandshake) {
      // Post-stop spawn path: only short-circuit when Control already reports this build.
            let runningBuildId: string | undefined;
      if (existing.controlUrl && existing.controlToken) {
        try {
          const { ControlHttpClient } = await import("@pairmesh/client");
          const client = new ControlHttpClient({
            baseUrl: existing.controlUrl,
            controlToken: existing.controlToken
          });
          runningBuildId = (await client.getStatus()).buildId;
        } catch {
          runningBuildId = undefined;
        }
      }
      if (runningBuildId === PAIRMESH_BUILD_ID) {
        await clearDeferredRestart(runtime.workspace);
        return {
          runtime,
          pid: existing.pid,
          healthLabel: formatHealthLabel(inspection.health),
          alreadyRunning: true
        };
      }
      // Mismatch or unreachable — fall through to spawn after stop cleared metadata.
    } else {
      const { ensureRuntimeUpgrade } = await import("./upgrade-handshake.js");
      const upgradeOutcome = await ensureRuntimeUpgrade({
        workspace: runtime.workspace,
        bindHost: runtime.host
      });
      if (upgradeOutcome.kind === "incompatible") {
        const { formatUpgradeUx } = await import("./upgrade-handshake.js");
        throw new Error(
          formatUpgradeUx(upgradeOutcome) ??
            `${productDisplayName()} CLI and runtime are incompatible.`
        );
      }
      if (upgradeOutcome.kind === "updated") {
        const after = await readRuntimeInfo(runtime.workspace);
        const afterInspection = await inspectManagedRuntime(
          runtime.workspace,
          runtime.config,
          after
        );
        return {
          runtime,
          pid: upgradeOutcome.pid,
          healthLabel: formatHealthLabel(afterInspection.health),
          alreadyRunning: false,
          upgradeOutcome
        };
      }
      // deferred / current / compatible_different / not_running — fall through if still verified
      const still = await readRuntimeInfo(runtime.workspace);
      const stillInspection = await inspectManagedRuntime(runtime.workspace, runtime.config, still);
      if (stillInspection.verified && still) {
        return {
          runtime,
          pid: still.pid,
          healthLabel: formatHealthLabel(stillInspection.health),
          alreadyRunning: true,
          upgradeOutcome
        };
      }
      // Runtime gone after handshake — continue to spawn
    }
  }

  if (inspection.stale) {
    await clearRuntimeInfo(runtime.workspace);
  }

  const logs = await openRuntimeLogHandles(runtime.workspace);
  const launch = resolveWorkerLaunch();
  let child: ChildProcess;
  try {
    child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", logs.stdoutFd, logs.stderrFd],
      cwd: launch.cwd,
      env: {
        ...process.env,
        PAIRMESH_PROJECT_ROOT: runtime.workspace,
        PAIRMESH_AGENT_PORT: String(runtime.port),
        PAIRMESH_AGENT_HOST: runtime.host,
        PAIRMESH_WORKSPACE: runtime.workspace,
        PAIRMESH_STATE_FILE: runtime.stateFilePath,
        PAIRMESH_PROJECT_ID: runtime.config.projectId,
        PAIRMESH_AGENT_NAME: runtime.agentName,
        PAIRMESH_CODING_AGENT_PROVIDER: runtime.codingAgentProvider,
        PAIRMESH_CODING_AGENT_MODE: runtime.codingAgentMode
      }
    });
  } finally {
    logs.close();
  }

  if (!child.pid) {
    throw new Error(`Failed to spawn ${productDisplayName()} background runtime.`);
  }

  child.unref();

  const ready = await waitForRuntimeReady(runtime.baseUrl, {
    projectId: runtime.config.projectId,
    agentName: runtime.agentName
  });

  if (!ready.verified) {
    await terminateOwnedChild(child);
    throw new Error(ready.reason ?? `${productDisplayName()} runtime failed to start.`);
  }

  const runtimeInfo = await readRuntimeInfo(runtime.workspace);
  const reportedPid = runtimeInfo?.pid ?? child.pid!;

  const deferred = await readDeferredRestart(runtime.workspace);
  if (deferred && deferred.targetBuildId === PAIRMESH_BUILD_ID) {
    await clearDeferredRestart(runtime.workspace);
  }

  return {
    runtime,
    pid: reportedPid,
    healthLabel: formatHealthLabel(ready.health),
    alreadyRunning: false
  };
}

async function terminateOwnedChild(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // ignore
  }
}

export async function resolveRuntimeForStart(input: {
  workspace: string;
  bindHost?: string;
  preservePort?: boolean;
}): Promise<ResolvedLocalRuntime> {
  const previous = input.preservePort ? await readRuntimeInfo(input.workspace) : null;
  return await resolveLocalRuntime({
    cwd: input.workspace,
    cli: {
      workspace: input.workspace,
      bindHost: input.bindHost
    },
    preferredPort: previous?.port
  });
}

export async function stopBackgroundRuntime(input: {
  workspace: string;
  force?: boolean;
}): Promise<boolean> {
  const runtime = await resolveLocalRuntime({
    cwd: input.workspace,
    cli: { workspace: input.workspace }
  });
  applyResolvedLocalRuntimeToEnv(runtime);

  const runtimeInfo = await readRuntimeInfo(runtime.workspace);
  if (!runtimeInfo) {
    return false;
  }

  const inspection = await inspectManagedRuntime(runtime.workspace, runtime.config, runtimeInfo);
  if (!inspection.verified) {
    await clearRuntimeInfo(runtime.workspace);
    return false;
  }

  await signalRuntimeStop(runtimeInfo.pid, input.force ?? false);
  await waitForProcessExit(runtimeInfo.pid, input.force ? 5_000 : 10_000);

  const after = await inspectManagedRuntime(runtime.workspace, runtime.config, runtimeInfo);
  if (after.verified) {
    if (input.force) {
      try {
        process.kill(runtimeInfo.pid, "SIGKILL");
      } catch {
        // ignore
      }
    } else {
      throw new Error(
        `${productDisplayName()} runtime did not stop gracefully. Try: ${cliBinaryLabel()} stop --force`
      );
    }
  }

  await clearRuntimeInfo(runtime.workspace);
  return true;
}

async function signalRuntimeStop(pid: number, force: boolean): Promise<void> {
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ESRCH")) {
      return;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}
