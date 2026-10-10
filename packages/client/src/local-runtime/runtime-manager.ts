import type { PairMeshRuntimeHealth } from "@pairmesh/protocol";
import type { PairMeshLocalConfig, PairMeshRuntimeInfo } from "../local-config/schema.js";
import { fetchLocalHealth } from "../health/peer-health.js";
import { isRuntimeProcessAlive } from "../local-config/runtime-info.js";

export interface ExpectedRuntimeIdentity {
  projectId: string;
  agentName: string;
}

export interface RuntimeVerificationResult {
  alive: boolean;
  verified: boolean;
  stale: boolean;
  health?: PairMeshRuntimeHealth;
  reason?: string;
}

export function healthMatchesIdentity(
  health: PairMeshRuntimeHealth,
  expected: ExpectedRuntimeIdentity
): boolean {
  if (health.agent.name !== expected.agentName) {
    return false;
  }
  if (health.project?.projectId && health.project.projectId !== expected.projectId) {
    return false;
  }
  return true;
}

export async function verifyRuntimeIdentity(
  baseUrl: string,
  expected: ExpectedRuntimeIdentity
): Promise<RuntimeVerificationResult> {
  const health = await fetchLocalHealth(baseUrl);
  if (!health) {
    return {
      alive: false,
      verified: false,
      stale: true,
      reason: "Health endpoint unreachable."
    };
  }

  if (!healthMatchesIdentity(health, expected)) {
    return {
      alive: true,
      verified: false,
      stale: true,
      health,
      reason: "Runtime identity mismatch."
    };
  }

  return {
    alive: true,
    verified: true,
    stale: false,
    health
  };
}

export async function inspectManagedRuntime(
  workspace: string,
  config: PairMeshLocalConfig,
  runtimeInfo: PairMeshRuntimeInfo | null
): Promise<RuntimeVerificationResult & { runtimeInfo: PairMeshRuntimeInfo | null }> {
  if (!runtimeInfo) {
    return {
      runtimeInfo: null,
      alive: false,
      verified: false,
      stale: false,
      reason: "No runtime metadata."
    };
  }

  const expected: ExpectedRuntimeIdentity = {
    projectId: config.projectId,
    agentName: runtimeInfo.agentName
  };

  const verification = await verifyRuntimeIdentity(runtimeInfo.baseUrl, expected);
  if (verification.verified) {
    return { ...verification, runtimeInfo };
  }

  const pidAlive = await isRuntimeProcessAlive(runtimeInfo);
  if (!pidAlive && !verification.alive) {
    return {
      ...verification,
      runtimeInfo,
      stale: true,
      reason: verification.reason ?? "Process not running."
    };
  }

  if (pidAlive && !verification.verified) {
    return {
      ...verification,
      runtimeInfo,
      stale: true,
      reason: verification.reason ?? "PID present but identity mismatch."
    };
  }

  return { ...verification, runtimeInfo, stale: !verification.verified };
}

export async function waitForRuntimeReady(
  baseUrl: string,
  expected: ExpectedRuntimeIdentity,
  timeoutMs = 15_000,
  intervalMs = 200
): Promise<RuntimeVerificationResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await verifyRuntimeIdentity(baseUrl, expected);
    if (result.verified) {
      return result;
    }
    await sleep(intervalMs);
  }

  return {
    alive: false,
    verified: false,
    stale: true,
    reason: `Runtime did not become ready within ${timeoutMs}ms.`
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
