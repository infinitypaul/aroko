/**
 * LocalSessionState persistence.
 *
 * R22-1 / R22-1C ownership model:
 * - One LocalStateStore instance per process owns a given state.json path.
 * - **Business/domain mutations use update()/mutate()** — always reload latest
 *   under the exclusive lock before applying changes.
 * - Cross-process writers serialize via the state-file lock.
 * - replaceEntireDocument() / save() is whole-document replacement only
 *   (bootstrap, join install, test seed) — never ordinary domain RMW.
 * - writeExclusive() may persist only inside an active exclusive section after
 *   a fresh load in that same section.
 */
import { createPairMeshError, parsePairMeshMetadata } from "@pairmesh/protocol";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { LocalSessionStateSchema, type LocalSessionState } from "../session/schemas.js";
import { getArokoHome } from "../local-config/paths.js";
import {
  DEFAULT_STATE_LOCK_ACQUIRE_TIMEOUT_MS,
  DEFAULT_STATE_LOCK_STALE_MS,
  withStateFileLock,
  type StateFileLockOptions
} from "./state-lock.js";

/** Local state holds plaintext session bearer tokens — keep it owner-only. */
export const STATE_DIRECTORY_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;

export interface LocalStateStoreOptions {
  /** Override default `~/.pairmesh/state.json` location (primarily for tests). */
  stateFilePath?: string;
  /** Cross-process lock acquisition timeout (default 10s). */
  lockAcquireTimeoutMs?: number;
  /** Retained for compatibility; live PIDs are never stolen by age (R22-1C). */
  lockStaleMs?: number;
  /**
   * Test harness only: disable queue + cross-process lock so independent
   * LocalStateStore instances can reproduce pre-R22-1 lost updates via save().
   */
  unsafeIndependentWriter?: boolean;
  /** Test hook for lock liveness checks. */
  isLockProcessAlive?: (pid: number) => boolean;
}

export class LocalStateStore {
  public readonly stateFilePath: string;
  public readonly lockDirPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private exclusiveDepth = 0;
  private readonly lockAcquireTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly unsafeIndependentWriter: boolean;
  private readonly isLockProcessAlive?: (pid: number) => boolean;

  public constructor(options: LocalStateStoreOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? defaultStateFilePath();
    this.lockDirPath = `${this.stateFilePath}.lock`;
    this.lockAcquireTimeoutMs =
      options.lockAcquireTimeoutMs ?? DEFAULT_STATE_LOCK_ACQUIRE_TIMEOUT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_STATE_LOCK_STALE_MS;
    this.unsafeIndependentWriter = options.unsafeIndependentWriter === true;
    this.isLockProcessAlive = options.isLockProcessAlive;
  }

  /**
   * Run work inside the exclusive RMW critical section (in-process queue +
   * cross-process lock). Prefer update()/mutate() for state changes.
   */
  public enqueue<T>(work: () => Promise<T>): Promise<T> {
    return this.runExclusive(work);
  }

  /**
   * Canonical domain API: load latest under lock → in-place mutate → validate → write.
   */
  public async mutate<T>(mutator: (state: LocalSessionState) => Promise<T> | T): Promise<T> {
    return this.runExclusive(async () => {
      const state = await this.loadUnlocked();
      if (!state) {
        throw createPairMeshError({
          code: "pairmesh.session_not_found",
          message: "No local PairMesh session found."
        });
      }
      const result = await mutator(state);
      await this.writeAtomicUnlocked(state);
      return result;
    });
  }

  /**
   * Canonical domain API: load latest under lock → functional mutator → validate → write.
   */
  public async update(
    mutator: (state: LocalSessionState) => LocalSessionState | Promise<LocalSessionState>
  ): Promise<LocalSessionState> {
    return this.runExclusive(async () => {
      const state = await this.loadUnlocked();
      if (!state) {
        throw createPairMeshError({
          code: "pairmesh.session_not_found",
          message: "No local PairMesh session found."
        });
      }
      const next = await mutator(state);
      await this.writeAtomicUnlocked(next);
      return next;
    });
  }

  public async load(): Promise<LocalSessionState | null> {
    return this.loadUnlocked();
  }

  /**
   * Persist inside an active exclusive section after a fresh load in that section.
   * Throws if called outside enqueue/update/mutate (unless unsafe test mode).
   */
  public async writeExclusive(state: LocalSessionState): Promise<void> {
    if (!this.unsafeIndependentWriter && this.exclusiveDepth <= 0) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message:
          "writeExclusive requires an active exclusive state section. Use update()/mutate() for domain RMW."
      });
    }
    await this.writeAtomicUnlocked(state);
  }

  /**
   * Whole-document replacement under the exclusive lock.
   *
   * Allowed for: bootstrap (createSession), join install of a new local document,
   * and test seeding. NOT for ordinary domain RMW — use update()/mutate().
   */
  public async replaceEntireDocument(state: LocalSessionState): Promise<void> {
    if (this.unsafeIndependentWriter) {
      await this.writeAtomicUnlocked(state);
      return;
    }
    return this.runExclusive(async () => {
      await this.writeAtomicUnlocked(state);
    });
  }

  /**
   * Alias of replaceEntireDocument for bootstrap/tests.
   * Domain code must use update()/mutate() — saving a snapshot loaded outside
   * the lock can lose concurrent mutations.
   */
  public async save(state: LocalSessionState): Promise<void> {
    return this.replaceEntireDocument(state);
  }

  public async clear(): Promise<void> {
    const clearFile = async (): Promise<void> => {
      try {
        await rm(this.stateFilePath, { force: true });
      } catch (error) {
        if (isEnoent(error)) {
          return;
        }
        throw createPairMeshError({
          code: "pairmesh.internal_error",
          message: "Failed to clear local PairMesh state file."
        });
      }
    };
    if (this.unsafeIndependentWriter) {
      await clearFile();
      return;
    }
    return this.runExclusive(clearFile);
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.unsafeIndependentWriter) {
      return work();
    }
    if (this.exclusiveDepth > 0) {
      return work();
    }
    const next = this.mutationQueue.then(
      () => this.runExclusiveBody(work),
      () => this.runExclusiveBody(work)
    );
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async runExclusiveBody<T>(work: () => Promise<T>): Promise<T> {
    if (this.exclusiveDepth > 0) {
      return work();
    }
    const lockOptions: StateFileLockOptions = {
      lockDirPath: this.lockDirPath,
      acquireTimeoutMs: this.lockAcquireTimeoutMs,
      staleMs: this.lockStaleMs,
      ...(this.isLockProcessAlive ? { isProcessAlive: this.isLockProcessAlive } : {})
    };
    return withStateFileLock(lockOptions, async () => {
      this.exclusiveDepth += 1;
      try {
        return await work();
      } finally {
        this.exclusiveDepth -= 1;
      }
    });
  }

  private async loadUnlocked(): Promise<LocalSessionState | null> {
    let raw: string;
    try {
      raw = await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return null;
      }
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "Failed to read local PairMesh state file."
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw createPairMeshError({
        code: "pairmesh.invalid_metadata",
        message: "Local PairMesh state file is not valid JSON."
      });
    }

    const parsed = parsePairMeshMetadata(LocalSessionStateSchema, parsedJson);
    if (!parsed.ok) {
      throw parsed.error;
    }

    return parsed.value;
  }

  /**
   * Atomic temp write + rename. No fsync (power-loss best-effort).
   * Orphan `.tmp` files are never authoritative.
   */
  private async writeAtomicUnlocked(state: LocalSessionState): Promise<void> {
    const validated = LocalSessionStateSchema.parse(state);
    const directory = dirname(this.stateFilePath);
    await mkdir(directory, { recursive: true, mode: STATE_DIRECTORY_MODE });
    await restrictMode(directory, STATE_DIRECTORY_MODE);

    const tempPath = `${this.stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: STATE_FILE_MODE
      });
      await restrictMode(tempPath, STATE_FILE_MODE);
      await rename(tempPath, this.stateFilePath);
      await restrictMode(this.stateFilePath, STATE_FILE_MODE);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function defaultStateFilePath(): string {
  return join(getArokoHome(), "state.json");
}

async function restrictMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  try {
    await chmod(path, mode);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
