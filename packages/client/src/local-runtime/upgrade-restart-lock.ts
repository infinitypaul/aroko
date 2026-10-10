
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectPairMeshDir } from "../local-config/paths.js";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../state/store.js";

export function upgradeRestartLockPath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "upgrade-restart.lock");
}

export interface UpgradeRestartLock {
  targetBuildId: string;
  holderPid: number;
  acquiredAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(workspace: string): Promise<UpgradeRestartLock | null> {
  try {
    const raw = JSON.parse(
      await readFile(upgradeRestartLockPath(workspace), "utf8")
    ) as UpgradeRestartLock;
    if (!raw?.targetBuildId || typeof raw.holderPid !== "number") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Acquire exclusive restart lock. Stale locks (dead holder PID) are cleared.
 * Returns false when another live CLI/runtime holds the lock.
 */
export async function tryAcquireUpgradeRestartLock(
  workspace: string,
  targetBuildId: string
): Promise<boolean> {
  const path = upgradeRestartLockPath(workspace);
  await mkdir(dirname(path), { recursive: true, mode: STATE_DIRECTORY_MODE });

  const existing = await readLock(workspace);
  if (existing) {
    if (isProcessAlive(existing.holderPid)) {
      return existing.holderPid === process.pid && existing.targetBuildId === targetBuildId;
    }
    await rm(path, { force: true });
  }

  const payload: UpgradeRestartLock = {
    targetBuildId,
    holderPid: process.pid,
    acquiredAt: new Date().toISOString()
  };

  try {
    const handle = await open(path, "wx", STATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      const raced = await readLock(workspace);
      if (raced && !isProcessAlive(raced.holderPid)) {
        await rm(path, { force: true });
        return tryAcquireUpgradeRestartLock(workspace, targetBuildId);
      }
      return false;
    }
    throw error;
  }
}

export async function releaseUpgradeRestartLock(workspace: string): Promise<void> {
  const existing = await readLock(workspace);
  if (existing && existing.holderPid !== process.pid) {
    return;
  }
  await rm(upgradeRestartLockPath(workspace), { force: true });
}

/** Wait until Control reports installed buildId, or timeout. */
export async function waitForRuntimeBuildId(
  readBuildId: () => Promise<string | null>,
  expectedBuildId: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buildId = await readBuildId();
    if (buildId === expectedBuildId) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function writeUpgradeRestartLockForTests(
  workspace: string,
  lock: UpgradeRestartLock
): Promise<void> {
  const path = upgradeRestartLockPath(workspace);
  await mkdir(dirname(path), { recursive: true, mode: STATE_DIRECTORY_MODE });
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, {
    encoding: "utf8",
    mode: STATE_FILE_MODE
  });
}
