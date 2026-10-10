import { createPairMeshError } from "@pairmesh/protocol";
import { readFile, lstat } from "node:fs/promises";
import { assertCommitPathConfined, assertProposalPathInsideWorkspace } from "../proposal/paths.js";
import {
  classifySection,
  contentSha256,
  orderLifecycleSections,
  reconstructCreateContents,
  reconstructDeleteContents,
  sectionAffectedPaths,
  type LifecycleOpKind
} from "./lifecycle-ops.js";
import {
  atomicDeleteTextFile,
  atomicRenameTextFile,
  atomicWriteTextFile,
  resolveWorkspaceFile
} from "./mutation-journal.js";
import {
  applyHunksToText,
  parseUnifiedDiffSections,
  type UnifiedDiffFileSection
} from "./unified-diff-apply.js";

export type ApplyFaultMode =
  | "none"
  | "before_write"
  | "after_validation"
  | "after_first_write"
  | "after_writes_before_result"
  /** After journal phase applying is recorded; before any filesystem mutation. */
  | "after_journal_applying"
  /** Fail immediately before committing the Nth planned op (1-based). */
  | `before_op_${number}`
  /** Fail immediately after successfully committing the Nth planned op (1-based). */
  | `after_op_${number}`;

export type PreparedLifecycleOp =
  | {
      kind: "create";
      relativePath: string;
      absolutePath: string;
      nextContents: string;
      label: string;
    }
  | {
      kind: "modify";
      relativePath: string;
      absolutePath: string;
      nextContents: string;
      previousBytes: number;
      nextBytes: number;
      label: string;
    }
  | {
      kind: "delete";
      relativePath: string;
      absolutePath: string;
      expectedHash: string;
      label: string;
    }
  | {
      kind: "rename";
      sourcePath: string;
      destPath: string;
      sourceAbsolute: string;
      destAbsolute: string;
      expectedHash: string;
      label: string;
    };

/** @deprecated Prefer PreparedLifecycleOp — kept for existing call sites expecting files[]. */
export interface PreparedFileApply {
  relativePath: string;
  absolutePath: string;
  nextContents: string;
  previousBytes: number;
  nextBytes: number;
}

export interface PatchApplyPlan {
  ops: PreparedLifecycleOp[];
  /** Binding paths covered by the plan. */
  bindingPaths: string[];
  filesChanged: number;
  bytesChanged: number;
  /** Back-compat: modify/create write targets only. */
  files: PreparedFileApply[];
}

export interface PatchApplyResult {
  appliedPaths: string[];
  failedPath?: string;
  filesChanged: number;
  bytesChanged: number;
  partial: boolean;
  appliedOps?: Array<{ kind: LifecycleOpKind; label: string }>;
}

/**
 * Validate and prepare all lifecycle operations. Mutates nothing on disk.
 */
export async function preparePatchApply(input: {
  workspaceRoot: string;
  unifiedDiff: string;
  allowedPaths: readonly string[];
}): Promise<PatchApplyPlan> {
  const sections = parseUnifiedDiffSections(input.unifiedDiff);
  const ordered = orderLifecycleSections(sections);
  const allowed = new Set(input.allowedPaths);
  const ops: PreparedLifecycleOp[] = [];
  let bytesChanged = 0;
  const touched = new Set<string>();

  for (const section of ordered) {
    for (const path of sectionAffectedPaths(section)) {
      if (!allowed.has(path)) {
        throw createPairMeshError({
          code: "pairmesh.action_binding_mismatch",
          message: "Patch path is outside the approved binding path set."
        });
      }
      touched.add(path);
    }

    const kind = classifySection(section);
    if (kind === "create") {
      ops.push(await prepareCreate(input.workspaceRoot, section));
      bytesChanged += Buffer.byteLength(
        (ops[ops.length - 1] as Extract<PreparedLifecycleOp, { kind: "create" }>).nextContents,
        "utf8"
      );
      continue;
    }
    if (kind === "delete") {
      ops.push(await prepareDelete(input.workspaceRoot, section));
      continue;
    }
    if (kind === "rename") {
      ops.push(await prepareRename(input.workspaceRoot, section));
      continue;
    }
    const modify = await prepareModify(input.workspaceRoot, section);
    bytesChanged += Math.abs(modify.nextBytes - modify.previousBytes);
    ops.push(modify);
  }

  for (const path of allowed) {
    if (!touched.has(path)) {
      throw createPairMeshError({
        code: "pairmesh.action_binding_mismatch",
        message: "Approved path set does not match proposal patch paths."
      });
    }
  }

  const files: PreparedFileApply[] = ops
    .filter(
      (op): op is Extract<PreparedLifecycleOp, { kind: "modify" | "create" }> =>
        op.kind === "modify" || op.kind === "create"
    )
    .map((op) => ({
      relativePath: op.relativePath,
      absolutePath: op.absolutePath,
      nextContents: op.nextContents,
      previousBytes: op.kind === "modify" ? op.previousBytes : 0,
      nextBytes: Buffer.byteLength(op.nextContents, "utf8")
    }));

  return {
    ops,
    bindingPaths: [...touched].sort(),
    filesChanged: ops.length,
    bytesChanged,
    files
  };
}

async function prepareCreate(
  workspaceRoot: string,
  section: UnifiedDiffFileSection
): Promise<Extract<PreparedLifecycleOp, { kind: "create" }>> {
  if (section.hunks.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: `CREATE ${section.relativePath} has no content hunks.`
    });
  }
  const relativePath = await assertProposalPathInsideWorkspace(workspaceRoot, section.relativePath);
  const absolutePath = resolveWorkspaceFile(workspaceRoot, relativePath);
  try {
    await lstat(absolutePath);
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: `CREATE refused: ${relativePath} already exists.`
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
  // Ancestor symlink / workspace checks already done by assertProposalPathInsideWorkspace.
  const nextContents = reconstructCreateContents(section.hunks);
  if (Buffer.from(nextContents, "utf8").includes(0)) {
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: "CREATE rejects binary files."
    });
  }
  return {
    kind: "create",
    relativePath,
    absolutePath,
    nextContents,
    label: relativePath
  };
}

async function prepareDelete(
  workspaceRoot: string,
  section: UnifiedDiffFileSection
): Promise<Extract<PreparedLifecycleOp, { kind: "delete" }>> {
  if (section.hunks.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: `DELETE ${section.relativePath} has no content hunks.`
    });
  }
  const relativePath = await assertProposalPathInsideWorkspace(workspaceRoot, section.relativePath);
  const absolutePath = resolveWorkspaceFile(workspaceRoot, relativePath);
  const stats = await lstatRegularFile(absolutePath, relativePath, "DELETE");
  void stats;
  const originalBytes = await readFile(absolutePath);
  if (originalBytes.includes(0)) {
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: "DELETE rejects binary files."
    });
  }
  const originalText = originalBytes.toString("utf8");
  const expected = reconstructDeleteContents(section.hunks);
  const expectedHash = contentSha256(expected);
  const actualHash = contentSha256(originalText);
  if (expectedHash !== actualHash) {
    throw createPairMeshError({
      code: "pairmesh.proposal_conflict",
      message: `DELETE refused: ${relativePath} no longer matches the approved content.`
    });
  }
  return {
    kind: "delete",
    relativePath,
    absolutePath,
    expectedHash,
    label: relativePath
  };
}

async function prepareRename(
  workspaceRoot: string,
  section: UnifiedDiffFileSection
): Promise<Extract<PreparedLifecycleOp, { kind: "rename" }>> {
  const sourcePath = await assertProposalPathInsideWorkspace(workspaceRoot, section.sourcePath!);
  const destPath = await assertProposalPathInsideWorkspace(workspaceRoot, section.destPath!);
  const sourceAbsolute = resolveWorkspaceFile(workspaceRoot, sourcePath);
  const destAbsolute = resolveWorkspaceFile(workspaceRoot, destPath);
  await lstatRegularFile(sourceAbsolute, sourcePath, "RENAME");
  try {
    await lstat(destAbsolute);
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: `RENAME refused: destination ${destPath} already exists.`
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
  const originalBytes = await readFile(sourceAbsolute);
  if (originalBytes.includes(0)) {
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: "RENAME rejects binary files."
    });
  }
  const expectedHash = contentSha256(originalBytes.toString("utf8"));
  return {
    kind: "rename",
    sourcePath,
    destPath,
    sourceAbsolute,
    destAbsolute,
    expectedHash,
    label: `${sourcePath}→${destPath}`
  };
}

async function prepareModify(
  workspaceRoot: string,
  section: UnifiedDiffFileSection
): Promise<Extract<PreparedLifecycleOp, { kind: "modify" }>> {
  if (section.hunks.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: `No hunks for ${section.relativePath}.`
    });
  }
  const relativePath = await assertProposalPathInsideWorkspace(workspaceRoot, section.relativePath);
  const absolutePath = resolveWorkspaceFile(workspaceRoot, relativePath);
  await lstatRegularFile(absolutePath, relativePath, "MODIFY");
  const originalBytes = await readFile(absolutePath);
  if (originalBytes.includes(0)) {
    throw createPairMeshError({
      code: "pairmesh.repository_edit_unsupported_operation",
      message: "MODIFY rejects binary files."
    });
  }
  const originalText = originalBytes.toString("utf8");
  const nextContents = applyHunksToText(originalText, section.hunks);
  return {
    kind: "modify",
    relativePath,
    absolutePath,
    nextContents,
    previousBytes: originalBytes.byteLength,
    nextBytes: Buffer.byteLength(nextContents, "utf8"),
    label: relativePath
  };
}

async function lstatRegularFile(
  absolutePath: string,
  relativePath: string,
  op: string
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw createPairMeshError({
        code: "pairmesh.proposal_path_denied",
        message: `Refusing to ${op.toLowerCase()} a symbolic link.`
      });
    }
    if (!stats.isFile()) {
      throw createPairMeshError({
        code: "pairmesh.repository_edit_unsupported_operation",
        message: `${op} only supports regular files (${relativePath}).`
      });
    }
    return stats;
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
        message: `${op} refused: ${relativePath} is missing.`
      });
    }
    throw error;
  }
}

export async function commitPatchApply(
  plan: PatchApplyPlan,
  options: {
    faultMode?: ApplyFaultMode;
    abortSignal?: AbortSignal;
    workspaceRoot?: string;
  } = {}
): Promise<PatchApplyResult> {
  const faultMode = options.faultMode ?? "none";
  if (
    faultMode === "after_validation" ||
    faultMode === "before_write" ||
    faultMode === "after_journal_applying"
  ) {
    throw createPairMeshError({
      code: "pairmesh.repository_apply_failed",
      message: `Injected fault: ${faultMode}`
    });
  }
  if (options.abortSignal?.aborted) {
    throw createPairMeshError({
      code: "pairmesh.action_cancelled",
      message: "Apply cancelled before writes."
    });
  }

  const workspaceRoot = options.workspaceRoot;
  const ops = plan.ops ?? [];
  const appliedPaths: string[] = [];
  const appliedOps: Array<{ kind: LifecycleOpKind; label: string }> = [];

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    const opNumber = i + 1;
    if (faultMode === `before_op_${opNumber}`) {
      throw Object.assign(
        createPairMeshError({
          code: "pairmesh.repository_apply_partial",
          message: `Injected fault before op ${opNumber} (${op.kind}).`
        }),
        { appliedPaths: [...appliedPaths] }
      );
    }
    if (options.abortSignal?.aborted) {
      return {
        appliedPaths,
        failedPath: op.label,
        filesChanged: appliedPaths.length,
        bytesChanged: plan.bytesChanged,
        partial: appliedPaths.length > 0,
        appliedOps
      };
    }

    // R22-3: revalidate full ancestor confinement immediately before each mutation.
    if (op.kind === "create") {
      const confined = workspaceRoot
        ? await assertCommitPathConfined(workspaceRoot, op.relativePath)
        : { relativePath: op.relativePath, absolutePath: op.absolutePath };
      await atomicWriteTextFile(confined.absolutePath, op.nextContents, { allowCreate: true });
      appliedPaths.push(op.relativePath);
    } else if (op.kind === "modify") {
      const confined = workspaceRoot
        ? await assertCommitPathConfined(workspaceRoot, op.relativePath)
        : { relativePath: op.relativePath, absolutePath: op.absolutePath };
      await lstatRegularFile(confined.absolutePath, op.relativePath, "MODIFY");
      await atomicWriteTextFile(confined.absolutePath, op.nextContents, { allowCreate: false });
      appliedPaths.push(op.relativePath);
    } else if (op.kind === "delete") {
      const confined = workspaceRoot
        ? await assertCommitPathConfined(workspaceRoot, op.relativePath)
        : { relativePath: op.relativePath, absolutePath: op.absolutePath };
      await lstatRegularFile(confined.absolutePath, op.relativePath, "DELETE");
      const bytes = await readFile(confined.absolutePath);
      if (contentSha256(bytes.toString("utf8")) !== op.expectedHash) {
        throw createPairMeshError({
          code: "pairmesh.proposal_conflict",
          message: `DELETE refused at commit: ${op.relativePath} changed since preflight.`
        });
      }
      await atomicDeleteTextFile(confined.absolutePath);
      appliedPaths.push(op.relativePath);
    } else {
      const source = workspaceRoot
        ? await assertCommitPathConfined(workspaceRoot, op.sourcePath)
        : { relativePath: op.sourcePath, absolutePath: op.sourceAbsolute };
      const dest = workspaceRoot
        ? await assertCommitPathConfined(workspaceRoot, op.destPath)
        : { relativePath: op.destPath, absolutePath: op.destAbsolute };
      await lstatRegularFile(source.absolutePath, op.sourcePath, "RENAME");
      const bytes = await readFile(source.absolutePath);
      if (contentSha256(bytes.toString("utf8")) !== op.expectedHash) {
        throw createPairMeshError({
          code: "pairmesh.proposal_conflict",
          message: `RENAME refused at commit: ${op.sourcePath} changed since preflight.`
        });
      }
      await atomicRenameTextFile(source.absolutePath, dest.absolutePath);
      appliedPaths.push(op.sourcePath, op.destPath);
    }
    appliedOps.push({ kind: op.kind, label: op.label });

    if (faultMode === `after_op_${opNumber}`) {
      throw Object.assign(
        createPairMeshError({
          code: "pairmesh.repository_apply_partial",
          message: `Injected fault after op ${opNumber} (${op.kind}).`
        }),
        { appliedPaths: [...appliedPaths] }
      );
    }
    if (faultMode === "after_first_write" && appliedOps.length === 1 && ops.length > 1) {
      throw Object.assign(
        createPairMeshError({
          code: "pairmesh.repository_apply_partial",
          message: "Injected fault after first file write."
        }),
        { appliedPaths: [...appliedPaths] }
      );
    }
  }

  // Legacy path: plans that only populated files[] (should not happen after R3).
  if (ops.length === 0 && plan.files.length > 0) {
    for (const file of plan.files) {
      if (workspaceRoot) {
        await assertCommitPathConfined(workspaceRoot, file.relativePath);
      }
      await atomicWriteTextFile(file.absolutePath, file.nextContents, { allowCreate: false });
      appliedPaths.push(file.relativePath);
    }
  }

  if (faultMode === "after_writes_before_result") {
    throw Object.assign(
      createPairMeshError({
        code: "pairmesh.action_unknown_outcome",
        message: "Injected fault after writes before durable result commit."
      }),
      { appliedPaths: [...appliedPaths], writesCompleted: true }
    );
  }

  return {
    appliedPaths,
    filesChanged: appliedOps.length || appliedPaths.length,
    bytesChanged: plan.bytesChanged,
    partial: false,
    appliedOps
  };
}
