import { createPairMeshError } from "@pairmesh/protocol";

export interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Lines including leading ' ', '-', '+', or '\\' markers (no trailing newline). */
  lines: string[];
}

export interface UnifiedDiffFileSection {
  relativePath: string;
  /** True when --- is /dev/null (file create). */
  isCreate: boolean;
  /** True when +++ is /dev/null (file delete). */
  isDelete: boolean;
  /** Content-preserving rename. */
  isRename: boolean;
  sourcePath?: string;
  destPath?: string;
  hunks: UnifiedDiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a normalized unified diff into per-file sections for apply.
 * Expects Aroko-normalized headers from parseAndNormalizeUnifiedDiff.
 */
export function parseUnifiedDiffSections(unifiedDiff: string): UnifiedDiffFileSection[] {
  const raw = unifiedDiff.replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const sections: UnifiedDiffFileSection[] = [];
  let current: UnifiedDiffFileSection | undefined;
  let pendingGit: { a: string; b: string } | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let pendingMinusDevNull = false;
  let pendingMinusPath: string | undefined;

  const flush = () => {
    current = undefined;
    pendingGit = undefined;
    renameFrom = undefined;
    renameTo = undefined;
    pendingMinusDevNull = false;
    pendingMinusPath = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: "Malformed diff --git header."
        });
      }
      pendingGit = { a: match[1]!, b: match[2]! };
      continue;
    }

    if (line.startsWith("rename from ")) {
      renameFrom = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = line.slice("rename to ".length).trim();
      continue;
    }

    if (line.startsWith("--- ")) {
      const path = line.slice(4).trim().split("\t")[0] ?? "";
      if (path === "/dev/null") {
        pendingMinusDevNull = true;
        pendingMinusPath = undefined;
      } else {
        pendingMinusDevNull = false;
        pendingMinusPath = path.replace(/^a\//, "");
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim().split("\t")[0] ?? "";
      const isDelete = path === "/dev/null";
      const isCreate = pendingMinusDevNull;
      const plusPath = isDelete ? undefined : path.replace(/^b\//, "");
      const gitA = pendingGit?.a;
      const gitB = pendingGit?.b;
      const isRename =
        Boolean(renameFrom && renameTo) ||
        Boolean(gitA && gitB && gitA !== gitB && !isCreate && !isDelete);

      if (isRename) {
        const sourcePath = renameFrom ?? gitA;
        const destPath = renameTo ?? gitB ?? plusPath;
        if (!sourcePath || !destPath) {
          throw createPairMeshError({
            code: "pairmesh.proposal_invalid",
            message: "RENAME section is missing source or destination."
          });
        }
        current = {
          relativePath: destPath,
          isCreate: false,
          isDelete: false,
          isRename: true,
          sourcePath,
          destPath,
          hunks: []
        };
      } else if (isCreate) {
        if (!plusPath) {
          throw createPairMeshError({
            code: "pairmesh.proposal_invalid",
            message: "CREATE section is missing destination path."
          });
        }
        current = {
          relativePath: plusPath,
          isCreate: true,
          isDelete: false,
          isRename: false,
          hunks: []
        };
      } else if (isDelete) {
        const deletePath = pendingMinusPath ?? gitA ?? renameFrom;
        if (!deletePath) {
          throw createPairMeshError({
            code: "pairmesh.proposal_invalid",
            message: "DELETE section is missing source path."
          });
        }
        current = {
          relativePath: deletePath,
          isCreate: false,
          isDelete: true,
          isRename: false,
          hunks: []
        };
      } else {
        const modifyPath = plusPath ?? pendingMinusPath ?? gitB ?? gitA;
        if (!modifyPath) {
          throw createPairMeshError({
            code: "pairmesh.proposal_invalid",
            message: "MODIFY section is missing path."
          });
        }
        current = {
          relativePath: modifyPath,
          isCreate: false,
          isDelete: false,
          isRename: false,
          hunks: []
        };
      }
      sections.push(current);
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      if (!current) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: "Hunk appears before file headers."
        });
      }
      current.hunks.push({
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: []
      });
      continue;
    }

    if (!current || current.hunks.length === 0) {
      continue;
    }
    if (
      line.startsWith(" ") ||
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith("\\")
    ) {
      current.hunks[current.hunks.length - 1]!.lines.push(line);
    }
  }

  if (sections.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Unified diff contains no file sections."
    });
  }
  return sections;
}

/**
 * Apply hunks strictly to existing text content. No fuzzy matching.
 */
export function applyHunksToText(original: string, hunks: UnifiedDiffHunk[]): string {
  if (hunks.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Patch section contains no hunks."
    });
  }

  const hadTrailingNewline = original.endsWith("\n");
  const source = hadTrailingNewline ? original.slice(0, -1) : original;
  const oldLines = source.length === 0 ? [] : source.split("\n");

  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  let lines = [...oldLines];

  for (const hunk of ordered) {
    lines = applyOneHunk(lines, hunk);
  }

  if (lines.length === 0) {
    return hadTrailingNewline ? "\n" : "";
  }
  const body = lines.join("\n");
  return hadTrailingNewline || original.length === 0 ? `${body}\n` : body;
}

function applyOneHunk(oldLines: string[], hunk: UnifiedDiffHunk): string[] {
  const expectedOld: string[] = [];
  const replacement: string[] = [];

  for (const line of hunk.lines) {
    if (line.startsWith("\\")) {
      continue;
    }
    const marker = line[0];
    const content = line.slice(1);
    if (marker === " ") {
      expectedOld.push(content);
      replacement.push(content);
    } else if (marker === "-") {
      expectedOld.push(content);
    } else if (marker === "+") {
      replacement.push(content);
    } else {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: "Malformed hunk line marker."
      });
    }
  }

  const startIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
  if (startIndex < 0 || startIndex + expectedOld.length > oldLines.length) {
    throw createPairMeshError({
      code: "pairmesh.proposal_conflict",
      message: "Patch context does not fit the current file (stale or drifted)."
    });
  }

  for (let i = 0; i < expectedOld.length; i += 1) {
    if (oldLines[startIndex + i] !== expectedOld[i]) {
      throw createPairMeshError({
        code: "pairmesh.proposal_conflict",
        message: "Patch context mismatch; refusing to overwrite local changes."
      });
    }
  }

  return [
    ...oldLines.slice(0, startIndex),
    ...replacement,
    ...oldLines.slice(startIndex + expectedOld.length)
  ];
}
