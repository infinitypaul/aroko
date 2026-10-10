import { createPairMeshError } from "@pairmesh/protocol";
import { PROPOSAL_V1_LIMITS } from "./limits.js";
import { assertProposalPathInsideWorkspace, normalizeProposalRelativePath } from "./paths.js";

export type NormalizedLifecycleKind = "modify" | "create" | "delete" | "rename";

export interface UnifiedDiffFileHunk {
  relativePath: string;
  kind: NormalizedLifecycleKind;
  /** Rename source (kind=rename). */
  sourcePath?: string;
  /** Rename destination (kind=rename). */
  destPath?: string;
  /** All binding paths touched by this section. */
  affectedPaths: string[];
  /** Raw per-file patch body including headers, for size accounting. */
  patchBytes: number;
}

export interface ParsedUnifiedDiff {
  files: UnifiedDiffFileHunk[];
  additions: number;
  deletions: number;
  /** Normalized unified diff with POSIX paths and deterministic file order. */
  normalizedDiff: string;
  /** Deduped sorted binding paths. */
  affectedPaths: string[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function stripPathNoise(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/dev/null") {
    return trimmed;
  }
  const withoutStamp = trimmed.split("\t")[0] ?? trimmed;
  return withoutStamp.replace(/^[ab]\//, "");
}

type FileBlock = {
  kind: NormalizedLifecycleKind;
  path: string;
  sourcePath?: string;
  destPath?: string;
  lines: string[];
};

/**
 * Parse and normalize a unified-diff-like proposal representation.
 * Supports MODIFY, CREATE (/dev/null), DELETE (/dev/null), and content-preserving RENAME.
 * File sections are sorted deterministically for hashing.
 */
export async function parseAndNormalizeUnifiedDiff(
  unifiedDiff: string,
  workspaceRoot: string
): Promise<ParsedUnifiedDiff> {
  const raw = unifiedDiff.replace(/\r\n/g, "\n");
  if (Buffer.byteLength(raw, "utf8") > PROPOSAL_V1_LIMITS.maxUnifiedDiffBytes) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Unified diff exceeds receiver V1 size limit."
    });
  }

  const lines = raw.split("\n");
  const blocks: FileBlock[] = [];
  let current: FileBlock | undefined;
  let additions = 0;
  let deletions = 0;
  let pendingGit: { aPath: string; bPath: string } | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let minusPath: string | undefined;
  let plusPath: string | undefined;

  const flushHeaders = () => {
    if (!current) {
      return;
    }
    // Headers already written into current.lines during parsing.
  };

  for (const line of lines) {
    const gitMatch = line.match(DIFF_GIT_RE);
    if (gitMatch) {
      flushHeaders();
      pendingGit = {
        aPath: stripPathNoise(gitMatch[1]!),
        bPath: stripPathNoise(gitMatch[2]!)
      };
      renameFrom = undefined;
      renameTo = undefined;
      minusPath = undefined;
      plusPath = undefined;
      current = undefined;
      continue;
    }

    if (line.startsWith("rename from ")) {
      renameFrom = normalizeProposalRelativePath(line.slice("rename from ".length).trim());
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = normalizeProposalRelativePath(line.slice("rename to ".length).trim());
      continue;
    }
    // Ignore similarity / index / copy lines — not authoritative.
    if (
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ") ||
      line.startsWith("index ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ")
    ) {
      continue;
    }

    if (line.startsWith("--- ")) {
      minusPath = stripPathNoise(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      plusPath = stripPathNoise(line.slice(4));
      const block = startBlockFromHeaders({
        pendingGit,
        renameFrom,
        renameTo,
        minusPath,
        plusPath
      });
      current = block;
      blocks.push(block);
      // Emit normalized headers only (no similarity noise).
      if (block.kind === "rename") {
        block.lines.push(`diff --git a/${block.sourcePath} b/${block.destPath}`);
        block.lines.push(`rename from ${block.sourcePath}`);
        block.lines.push(`rename to ${block.destPath}`);
        block.lines.push(`--- a/${block.sourcePath}`);
        block.lines.push(`+++ b/${block.destPath}`);
      } else if (block.kind === "create") {
        block.lines.push(`diff --git a/${block.path} b/${block.path}`);
        block.lines.push(`--- /dev/null`);
        block.lines.push(`+++ b/${block.path}`);
      } else if (block.kind === "delete") {
        block.lines.push(`diff --git a/${block.path} b/${block.path}`);
        block.lines.push(`--- a/${block.path}`);
        block.lines.push(`+++ /dev/null`);
      } else {
        block.lines.push(`diff --git a/${block.path} b/${block.path}`);
        block.lines.push(`--- a/${block.path}`);
        block.lines.push(`+++ b/${block.path}`);
      }
      continue;
    }

    if (!current && (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"))) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: "Unified diff is missing file headers."
      });
    }

    if (!current) {
      continue;
    }

    if (
      blockIsRename(current) &&
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message:
          "RENAME must be content-preserving; represent edits as a separate MODIFY operation."
      });
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
    // Skip duplicate header lines if provider repeated them after +++.
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue;
    }
    current.lines.push(line);
  }

  if (blocks.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Unified diff contains no file sections."
    });
  }
  if (blocks.length > PROPOSAL_V1_LIMITS.maxFiles) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: `Unified diff exceeds receiver max file count (${PROPOSAL_V1_LIMITS.maxFiles}).`
    });
  }

  const validated: FileBlock[] = [];
  for (const block of blocks) {
    const paths = block.kind === "rename" ? [block.sourcePath!, block.destPath!] : [block.path];
    for (const path of paths) {
      await assertProposalPathInsideWorkspace(workspaceRoot, path);
    }
    const primary =
      block.kind === "rename"
        ? await assertProposalPathInsideWorkspace(workspaceRoot, block.destPath!)
        : await assertProposalPathInsideWorkspace(workspaceRoot, block.path);
    const sourcePath =
      block.kind === "rename"
        ? await assertProposalPathInsideWorkspace(workspaceRoot, block.sourcePath!)
        : undefined;
    const patchText = `${block.lines.join("\n")}\n`;
    const patchBytes = Buffer.byteLength(patchText, "utf8");
    if (patchBytes > PROPOSAL_V1_LIMITS.maxPerFilePatchBytes) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `Per-file patch exceeds receiver V1 limit for ${primary}.`
      });
    }
    if (block.kind === "rename") {
      validated.push({
        kind: "rename",
        path: primary,
        sourcePath,
        destPath: primary,
        lines: rewriteRenameBlock(block.lines, sourcePath!, primary)
      });
    } else {
      validated.push({
        kind: block.kind,
        path: primary,
        lines: rewriteSinglePathBlock(block.lines, primary, block.kind)
      });
    }
  }

  validated.sort((a, b) => {
    const pathA = a.kind === "rename" ? a.destPath! : a.path;
    const pathB = b.kind === "rename" ? b.destPath! : b.path;
    if (pathA < pathB) {
      return -1;
    }
    if (pathA > pathB) {
      return 1;
    }
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  // Conflict check on normalized blocks
  assertNormalizeConflicts(validated);

  const normalizedDiff = validated.map((block) => block.lines.join("\n")).join("\n") + "\n";
  const files: UnifiedDiffFileHunk[] = validated.map((block) => {
    const affectedPaths =
      block.kind === "rename" ? [block.sourcePath!, block.destPath!] : [block.path];
    return {
      relativePath: block.kind === "rename" ? block.destPath! : block.path,
      kind: block.kind,
      sourcePath: block.sourcePath,
      destPath: block.destPath,
      affectedPaths,
      patchBytes: Buffer.byteLength(`${block.lines.join("\n")}\n`, "utf8")
    };
  });
  const affectedPaths = [...new Set(files.flatMap((file) => file.affectedPaths))].sort();

  return {
    files,
    additions,
    deletions,
    normalizedDiff,
    affectedPaths
  };
}

function blockIsRename(block: FileBlock): boolean {
  return block.kind === "rename";
}

function startBlockFromHeaders(input: {
  pendingGit?: { aPath: string; bPath: string };
  renameFrom?: string;
  renameTo?: string;
  minusPath?: string;
  plusPath?: string;
}): FileBlock {
  const { pendingGit, renameFrom, renameTo, minusPath, plusPath } = input;
  if (!minusPath || !plusPath) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Unified diff file section is missing ---/+++ headers."
    });
  }

  const isCreate = minusPath === "/dev/null";
  const isDelete = plusPath === "/dev/null";
  if (isCreate && isDelete) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Invalid diff targets /dev/null on both sides."
    });
  }

  if (isCreate) {
    const path = normalizeProposalRelativePath(plusPath);
    return { kind: "create", path, lines: [] };
  }
  if (isDelete) {
    const path = normalizeProposalRelativePath(minusPath);
    return { kind: "delete", path, lines: [] };
  }

  const aNorm = normalizeProposalRelativePath(minusPath);
  const bNorm = normalizeProposalRelativePath(plusPath);
  const gitRename =
    pendingGit &&
    pendingGit.aPath !== "/dev/null" &&
    pendingGit.bPath !== "/dev/null" &&
    pendingGit.aPath !== pendingGit.bPath;
  const explicitRename = Boolean(renameFrom && renameTo);
  if (gitRename || explicitRename || aNorm !== bNorm) {
    const sourcePath = normalizeProposalRelativePath(renameFrom ?? pendingGit?.aPath ?? minusPath);
    const destPath = normalizeProposalRelativePath(renameTo ?? pendingGit?.bPath ?? plusPath);
    if (sourcePath === destPath) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: "RENAME source and destination must differ."
      });
    }
    return {
      kind: "rename",
      path: destPath,
      sourcePath,
      destPath,
      lines: []
    };
  }

  return { kind: "modify", path: aNorm, lines: [] };
}

function rewriteSinglePathBlock(
  lines: string[],
  path: string,
  kind: NormalizedLifecycleKind
): string[] {
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  if (kind === "create") {
    out.push(`--- /dev/null`);
    out.push(`+++ b/${path}`);
  } else if (kind === "delete") {
    out.push(`--- a/${path}`);
    out.push(`+++ /dev/null`);
  } else {
    out.push(`--- a/${path}`);
    out.push(`+++ b/${path}`);
  }
  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue;
    }
    out.push(line);
  }
  return out;
}

function rewriteRenameBlock(lines: string[], sourcePath: string, destPath: string): string[] {
  const out: string[] = [];
  out.push(`diff --git a/${sourcePath} b/${destPath}`);
  out.push(`rename from ${sourcePath}`);
  out.push(`rename to ${destPath}`);
  out.push(`--- a/${sourcePath}`);
  out.push(`+++ b/${destPath}`);
  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue;
    }
    // Reject content-changing lines (already checked, keep context-only if any).
    if (
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message:
          "RENAME must be content-preserving; represent edits as a separate MODIFY operation."
      });
    }
    out.push(line);
  }
  return out;
}

function assertNormalizeConflicts(blocks: FileBlock[]): void {
  const kindsByPath = new Map<string, NormalizedLifecycleKind[]>();
  const renameSources = new Set<string>();
  const renameDests = new Set<string>();

  for (const block of blocks) {
    if (block.kind === "rename") {
      const src = block.sourcePath!;
      const dst = block.destPath!;
      if (
        renameSources.has(src) ||
        renameDests.has(src) ||
        renameSources.has(dst) ||
        renameDests.has(dst)
      ) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: `Conflicting RENAME involving ${src} or ${dst}.`
        });
      }
      renameSources.add(src);
      renameDests.add(dst);
      pushKind(kindsByPath, src, "rename");
      pushKind(kindsByPath, dst, "rename");
      continue;
    }
    pushKind(kindsByPath, block.path, block.kind);
  }

  for (const [path, kinds] of kindsByPath) {
    const creates = kinds.filter((k) => k === "create").length;
    const deletes = kinds.filter((k) => k === "delete").length;
    const modifies = kinds.filter((k) => k === "modify").length;
    if (creates > 1 || deletes > 1 || modifies > 1) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `Duplicate lifecycle operations on ${path}.`
      });
    }
    if (creates && deletes) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `CREATE and DELETE conflict on ${path}.`
      });
    }
    if (creates && modifies) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `CREATE and MODIFY conflict on ${path}.`
      });
    }
    if (deletes && modifies) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `DELETE and MODIFY conflict on ${path}.`
      });
    }
    if (creates && renameDests.has(path)) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `RENAME destination conflicts with CREATE on ${path}.`
      });
    }
    if (deletes && renameSources.has(path)) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `RENAME source conflicts with DELETE on ${path}.`
      });
    }
  }

  const lower = new Map<string, string>();
  for (const block of blocks) {
    const paths = block.kind === "rename" ? [block.sourcePath!, block.destPath!] : [block.path];
    for (const path of paths) {
      const key = path.toLowerCase();
      const prev = lower.get(key);
      if (prev && prev !== path) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: `Case-only path collision between ${prev} and ${path}.`
        });
      }
      lower.set(key, path);
    }
  }
}

function pushKind(
  map: Map<string, NormalizedLifecycleKind[]>,
  path: string,
  kind: NormalizedLifecycleKind
): void {
  const list = map.get(path) ?? [];
  list.push(kind);
  map.set(path, list);
}
