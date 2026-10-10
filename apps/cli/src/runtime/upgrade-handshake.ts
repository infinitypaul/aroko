
import {
  ControlHttpClient,
  PAIRMESH_BUILD_ID,
  PAIRMESH_VERSION,
  applyResolvedLocalRuntimeToEnv,
  clearDeferredRestart,
  compareInstalledToRunning,
  configureReliabilityTracker,
  getReliabilityTracker,
  readDeferredRestart,
  readInstalledRuntimeIdentity,
  readRuntimeInfo,
  releaseUpgradeRestartLock,
  runtimeIdentityFromControlStatus,
  tryAcquireUpgradeRestartLock,
  waitForRuntimeBuildId,
  writeDeferredRestart,
  type ControlStatusView,
  type RuntimeCompatibilityResult
} from "@pairmesh/client";
import { productDisplayName } from "../cli-brand.js";
import {
  resolveRuntimeForStart,
  startBackgroundRuntime,
  stopBackgroundRuntime
} from "./background-runtime.js";

export type UpgradeHandshakeOutcome =
  | { kind: "current" }
  | { kind: "updated"; pid: number }
  | { kind: "deferred"; busyReasons: string[] }
  | { kind: "incompatible"; compatibility: RuntimeCompatibilityResult; status: ControlStatusView }
  | { kind: "compatible_different"; compatibility: RuntimeCompatibilityResult }
  | { kind: "not_running" };

export interface EnsureRuntimeUpgradeOptions {
  workspace: string;
  /** When true, may stop+start a verified runtime. Default true. */
  allowRestart?: boolean;
  bindHost?: string;
}

function isRuntimeIdleFromStatus(status: ControlStatusView): {
  idle: boolean;
  busyReasons: string[];
} {
  const busyReasons = status.runtime.busyReasons ?? [];
  if (busyReasons.length > 0) {
    return { idle: false, busyReasons };
  }
  if (status.runtime.idle === false) {
    return { idle: false, busyReasons: [`active ${productDisplayName()} work`] };
  }
  return { idle: true, busyReasons: [] };
}

async function readRunningBuildId(workspace: string): Promise<string | null> {
  const runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    return null;
  }
  try {
    const client = new ControlHttpClient({
      baseUrl: runtimeInfo.controlUrl,
      controlToken: runtimeInfo.controlToken
    });
    const status = await client.getStatus();
    return status.buildId?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Compare installed CLI build to the running runtime via Control status.
 * Restarts when idle + restart_required; defers when busy; errors when incompatible.
 */
export async function ensureRuntimeUpgrade(
  options: EnsureRuntimeUpgradeOptions
): Promise<UpgradeHandshakeOutcome> {
  const workspace = options.workspace;
  const allowRestart = options.allowRestart !== false;
  const installed = readInstalledRuntimeIdentity();

  const runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    const deferred = await readDeferredRestart(workspace);
    if (deferred && deferred.targetBuildId === installed.buildId) {
      await clearDeferredRestart(workspace);
    }
    return { kind: "not_running" };
  }

  let status: ControlStatusView;
  try {
    const client = new ControlHttpClient({
      baseUrl: runtimeInfo.controlUrl,
      controlToken: runtimeInfo.controlToken
    });
    status = await client.getStatus();
  } catch {
    return { kind: "not_running" };
  }

  const running = runtimeIdentityFromControlStatus(status);
  if (running.buildId === installed.buildId) {
    await clearDeferredRestart(workspace);
    return { kind: "current" };
  }

  const compatibility = compareInstalledToRunning(installed, running);
  if (compatibility.kind === "incompatible") {
    return { kind: "incompatible", compatibility, status };
  }
  if (compatibility.kind === "compatible_different") {
    return { kind: "compatible_different", compatibility };
  }
  if (compatibility.kind === "exact") {
    await clearDeferredRestart(workspace);
    return { kind: "current" };
  }

  const { idle, busyReasons } = isRuntimeIdleFromStatus(status);

  if (!idle) {
    await writeDeferredRestart(workspace, {
      targetBuildId: installed.buildId,
      targetVersion: installed.version,
      requestedAt: new Date().toISOString(),
      reason: compatibility.reason ?? "Package update installed while runtime was busy."
    });
    return { kind: "deferred", busyReasons };
  }

  if (!allowRestart) {
    await writeDeferredRestart(workspace, {
      targetBuildId: installed.buildId,
      targetVersion: installed.version,
      requestedAt: new Date().toISOString(),
      reason: compatibility.reason ?? "Package update requires runtime restart."
    });
    return { kind: "deferred", busyReasons: ["restart deferred"] };
  }

  const acquired = await tryAcquireUpgradeRestartLock(workspace, installed.buildId);
  if (!acquired) {
    const matched = await waitForRuntimeBuildId(
      () => readRunningBuildId(workspace),
      installed.buildId,
      45_000
    );
    if (matched) {
      await clearDeferredRestart(workspace);
      const after = await readRuntimeInfo(workspace);
      return { kind: "updated", pid: after?.pid ?? runtimeInfo.pid };
    }
    await writeDeferredRestart(workspace, {
      targetBuildId: installed.buildId,
      targetVersion: installed.version,
      requestedAt: new Date().toISOString(),
      reason: "Concurrent upgrade restart in progress; deferred for retry."
    });
    return { kind: "deferred", busyReasons: ["concurrent upgrade"] };
  }

  try {
    configureReliabilityTracker({ workspace });
    const tracker = getReliabilityTracker();
    const upgradeSpan = tracker.begin("runtime.upgrade_to_ready", {
      transport: "relay",
      replacePrior: true,
      phase: "restart_begin",
      reason: "build_mismatch"
    });

    await stopBackgroundRuntime({ workspace, force: false });
    const runtime = await resolveRuntimeForStart({
      workspace,
      bindHost: options.bindHost,
      preservePort: true
    });
    applyResolvedLocalRuntimeToEnv(runtime);
    const started = await startBackgroundRuntime(runtime, { skipUpgradeHandshake: true });
    await clearDeferredRestart(workspace);

    const afterInfo = await readRuntimeInfo(workspace);
    if (afterInfo?.controlUrl && afterInfo.controlToken) {
      try {
        const client = new ControlHttpClient({
          baseUrl: afterInfo.controlUrl,
          controlToken: afterInfo.controlToken
        });
        const afterStatus = await client.getStatus();
        if (afterStatus.buildId && afterStatus.buildId !== PAIRMESH_BUILD_ID) {
          tracker.complete(upgradeSpan.id, {
            outcome: "failed",
            reason: "build_mismatch_after_restart"
          });
          await writeDeferredRestart(workspace, {
            targetBuildId: PAIRMESH_BUILD_ID,
            targetVersion: PAIRMESH_VERSION,
            requestedAt: new Date().toISOString(),
            reason: "Runtime restart completed but buildId still mismatched."
          });
        } else {
          tracker.complete(upgradeSpan.id, {
            outcome: "success",
            phase: "build_match"
          });
        }
      } catch {
        tracker.complete(upgradeSpan.id, {
          outcome: "failed",
          reason: "control_unreachable"
        });
      }
    } else {
      tracker.complete(upgradeSpan.id, {
        outcome: "failed",
        reason: "runtime_info_missing"
      });
    }

    return { kind: "updated", pid: started.pid };
  } finally {
    await releaseUpgradeRestartLock(workspace);
  }
}

/**
 * Control-touching commands: check compatibility; restart when idle; surface UX.
 * Does not throw for deferred/current; throws for incompatible protocol.
 */
export async function ensureRuntimeUpgradeForCommand(
  workspace: string,
  options: { allowRestart?: boolean; bindHost?: string; quiet?: boolean } = {}
): Promise<UpgradeHandshakeOutcome> {
  const outcome = await ensureRuntimeUpgrade({
    workspace,
    allowRestart: options.allowRestart,
    bindHost: options.bindHost
  });
  if (outcome.kind === "incompatible") {
    throw new Error(
      formatUpgradeUx(outcome) ?? `${productDisplayName()} CLI and runtime are incompatible.`
    );
  }
  if (!options.quiet) {
    const message = formatUpgradeUx(outcome);
    if (message) {
      console.log(message);
      console.log("");
    }
  }
  return outcome;
}

export function formatUpgradeUx(outcome: UpgradeHandshakeOutcome): string | null {
  const product = productDisplayName();
  switch (outcome.kind) {
    case "updated":
      return `${product} runtime updated and reconnected.`;
    case "deferred":
      return [
        `${product} update installed.`,
        "Current work is still running.",
        "Runtime will restart automatically when idle."
      ].join("\n");
    case "incompatible":
      return [
        `${product} CLI and runtime are incompatible.`,
        outcome.compatibility.reason ?? "",
        `Runtime: ${outcome.status.version}${
          outcome.status.buildId ? ` (${outcome.status.buildId})` : ""
        }`,
        `CLI: ${PAIRMESH_VERSION} (${PAIRMESH_BUILD_ID})`
      ]
        .filter(Boolean)
        .join("\n");
    case "compatible_different":
      return null;
    default:
      return null;
  }
}
