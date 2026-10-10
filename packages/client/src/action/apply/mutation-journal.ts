import { createPairMeshError } from "@pairmesh/protocol";
import { mkdir, readFile, rename, unlink, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type MutationJournalPhase = "applying" | "applied";

/**
 * Durable apply journal phases (R3 / R22-3):
 *
 * | Phase      | Meaning                                      | Restart behavior                          |
 * |------------|----------------------------------------------|-------------------------------------------|
 * | (absent)   | No apply started for this actionId           | May prepare+commit per normal flow        |
 * | applying   | Journal recorded; FS mutation may have begun | → unknown_outcome; never auto-retry       |
 * | applied    | At least one mutation committed or uncertain | → unknown_outcome / terminal; no retry    |
 *
 * Prepare/preflight is in-memory only (not a durable journal phase).
 * Once `applying` is written, crash ⇒ unknown outcome (no blind second apply).
 * Journal prevents duplicate execution; it does NOT promise transactional rollback.
 */
export interface MutationJournalRecord {
  actionId: string;
  phase: MutationJournalPhase;
  workspaceRoot: string;
  paths: string[];
  appliedPaths: string[];
  updatedAt: string;
}

function journalDir(actionsRoot: string): string {
  return join(actionsRoot, ".mutation-journal");
}

function journalPath(actionsRoot: string, actionId: string): string {
  return join(journalDir(actionsRoot), `${actionId}.json`);
}

export async function readMutationJournal(
  actionsRoot: string,
  actionId: string
): Promise<MutationJournalRecord | undefined> {
  try {
    const raw = await readFile(journalPath(actionsRoot, actionId), "utf8");
    return JSON.parse(raw) as MutationJournalRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeMutationJournal(
  actionsRoot: string,
  record: MutationJournalRecord
): Promise<void> {
  const dir = journalDir(actionsRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = journalPath(actionsRoot, record.actionId);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export async function clearMutationJournal(actionsRoot: string, actionId: string): Promise<void> {
  try {
    await unlink(journalPath(actionsRoot, actionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function rethrowPairMesh(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("pairmesh.")
  ) {
    throw error;
  }
  throw error;
}

/**
 * Atomic create or replace of a regular file under workspaceRoot.
 * CREATE mode: destination must not exist.
 * MODIFY mode: destination must be an existing regular file (not symlink).
 */
export async function atomicWriteTextFile(
  absolutePath: string,
  contents: string,
  options: { allowCreate?: boolean } = {}
): Promise<void> {
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true, mode: 0o755 });

  let exists = false;
  try {
    const existing = await lstat(absolutePath);
    exists = true;
    if (existing.isSymbolicLink()) {
      throw createPairMeshError({
        code: "pairmesh.proposal_path_denied",
        message: "Refusing to mutate a symbolic link."
      });
    }
    if (!existing.isFile()) {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: "repository.edit only mutates regular files."
      });
    }
    if (options.allowCreate) {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: "CREATE refused: destination already exists."
      });
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      (error as { code: string }).code.startsWith("pairmesh.")
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (!options.allowCreate) {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: "MODIFY refused: file is missing."
      });
    }
  }

  if (!options.allowCreate && !exists) {
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: "MODIFY refused: file is missing."
    });
  }

  const temp = join(directory, `.pairmesh-apply-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o644 });
    await rename(temp, absolutePath);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

export async function atomicDeleteTextFile(absolutePath: string): Promise<void> {
  try {
    const existing = await lstat(absolutePath);
    if (existing.isSymbolicLink()) {
      throw createPairMeshError({
        code: "pairmesh.proposal_path_denied",
        message: "Refusing to delete a symbolic link."
      });
    }
    if (!existing.isFile()) {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: "DELETE only removes regular files."
      });
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      (error as { code: string }).code.startsWith("pairmesh.")
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw createPairMeshError({
        code: "pairmesh.proposal_conflict",
        message: "DELETE refused: file is missing."
      });
    }
    rethrowPairMesh(error);
  }
  await unlink(absolutePath);
}

/**
 * Content-preserving rename within one workspace. Fail closed on EXDEV.
 */
export async function atomicRenameTextFile(
  sourceAbsolute: string,
  destAbsolute: string
): Promise<void> {
  const destDir = dirname(destAbsolute);
  await mkdir(destDir, { recursive: true, mode: 0o755 });

  try {
    const source = await lstat(sourceAbsolute);
    if (source.isSymbolicLink()) {
      throw createPairMeshError({
        code: "pairmesh.proposal_path_denied",
        message: "Refusing to rename a symbolic link."
      });
    }
    if (!source.isFile()) {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: "RENAME only moves regular files."
      });
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      (error as { code: string }).code.startsWith("pairmesh.")
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw createPairMeshError({
        code: "pairmesh.proposal_conflict",
        message: "RENAME refused: source is missing."
      });
    }
    throw error;
  }

  try {
    await lstat(destAbsolute);
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: "RENAME refused: destination already exists."
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      (error as { code: string }).code.startsWith("pairmesh.")
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await rename(sourceAbsolute, destAbsolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: "RENAME across filesystems is not supported."
      });
    }
    throw error;
  }
}

export function resolveWorkspaceFile(workspaceRoot: string, relativePath: string): string {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, ...relativePath.split("/"));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Resolved apply path escapes the project root."
    });
  }
  return absolute;
}
