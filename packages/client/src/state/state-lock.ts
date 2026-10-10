/**
 * R22-1 / R22-1C cross-process exclusive lock for `.pairmesh/state.json` RMW.
 *
 * Protocol: atomic create of a lock *file* via writeFile flag `wx` (O_EXCL).
 * Contents: JSON `{ pid, startedAt }`.
 *
 * Stale recovery (R22-1C):
 * - corrupt / unreadable holder → clear
 * - owner PID dead (or invalid) → clear
 * - owner PID **alive** → NEVER steal solely because age > staleMs
 * - hung live holder → acquisition timeout fails closed (no unlocked fallback)
 *
 * PID liveness caveats (same host): `process.kill(pid, 0)` — EPERM treated as alive;
 * Windows/posix differences exist; pid reuse is a residual low risk.
 */
import { createPairMeshError } from "@pairmesh/protocol";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_STATE_LOCK_STALE_MS = 30_000;
export const DEFAULT_STATE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
export const DEFAULT_STATE_LOCK_POLL_MS = 25;

export interface StateFileLockOptions {
  /** Lock file path (sibling of state.json, typically `state.json.lock`). */
  lockDirPath: string;
  /**
   * Unused for live-PID steal (R22-1C). Retained for API compatibility /
   * documentation of historical age-based recovery.
   */
  staleMs?: number;
  acquireTimeoutMs?: number;
  pollMs?: number;
  /** Test hook — override "is pid alive?" */
  isProcessAlive?: (pid: number) => boolean;
}

interface LockHolder {
  pid: number;
  startedAt: string;
}

export async function withStateFileLock<T>(
  options: StateFileLockOptions,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireStateFileLock(options);
  try {
    return await work();
  } finally {
    await release();
  }
}

export async function acquireStateFileLock(
  options: StateFileLockOptions
): Promise<() => Promise<void>> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_STATE_LOCK_ACQUIRE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_STATE_LOCK_POLL_MS;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const lockPath = options.lockDirPath;
  const deadline = Date.now() + acquireTimeoutMs;

  await mkdir(dirname(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    try {
      const holder: LockHolder = {
        pid: process.pid,
        startedAt: new Date().toISOString()
      };
      await writeFile(lockPath, `${JSON.stringify(holder)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isEexist(error)) {
        const errno =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as NodeJS.ErrnoException).code)
            : "unknown";
        throw createPairMeshError({
          code: "pairmesh.internal_error",
          message: `Failed to acquire PairMesh state file lock (${errno}).`
        });
      }
      await maybeRecoverStaleLock(lockPath, isAlive);
      await sleep(pollMs);
    }
  }

  throw createPairMeshError({
    code: "pairmesh.state_lock_timeout",
    message: `Timed out after ${acquireTimeoutMs}ms waiting for PairMesh state lock.`
  });
}

async function maybeRecoverStaleLock(
  lockPath: string,
  isAlive: (pid: number) => boolean
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    return;
  }
  let holder: LockHolder | null = null;
  try {
    holder = JSON.parse(raw) as LockHolder;
  } catch {
    await rm(lockPath, { force: true });
    return;
  }
  const pid = Number(holder?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    await rm(lockPath, { force: true });
    return;
  }
  // R22-1C: live owner must never be stolen due to age alone.
  if (isAlive(pid)) {
    return;
  }
  await rm(lockPath, { force: true });
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
