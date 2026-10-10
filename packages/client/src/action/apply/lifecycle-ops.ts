import { createPairMeshError } from "@pairmesh/protocol";
import { sha256Hex } from "../digest.js";
import type { UnifiedDiffFileSection, UnifiedDiffHunk } from "./unified-diff-apply.js";

export type LifecycleOpKind = "create" | "modify" | "rename" | "delete";

export const LIFECYCLE_OP_RANK: Record<LifecycleOpKind, number> = {
  create: 0,
  modify: 1,
  rename: 2,
  delete: 3
};

/** Reconstruct full file text from create hunks (all '+' lines). */
export function reconstructCreateContents(hunks: UnifiedDiffHunk[]): string {
  const lines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        continue;
      }
      if (line.startsWith("+")) {
        lines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        lines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: "CREATE patch must not contain deletion lines."
        });
      }
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Reconstruct pre-delete file text from delete hunks (all '-' / context lines). */
export function reconstructDeleteContents(hunks: UnifiedDiffHunk[]): string {
  const lines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        continue;
      }
      if (line.startsWith("-") || line.startsWith(" ")) {
        lines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: "DELETE patch must not contain addition lines."
        });
      }
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function contentSha256(text: string): string {
  return sha256Hex(text);
}

export function classifySection(section: UnifiedDiffFileSection): LifecycleOpKind {
  if (section.isRename) {
    return "rename";
  }
  if (section.isCreate) {
    return "create";
  }
  if (section.isDelete) {
    return "delete";
  }
  return "modify";
}

export function sectionAffectedPaths(section: UnifiedDiffFileSection): string[] {
  if (section.isRename) {
    return [section.sourcePath!, section.destPath!];
  }
  return [section.relativePath];
}

/**
 * Reject internally contradictory lifecycle sections (apply-time defense in depth).
 */
export function assertLifecycleConflicts(sections: UnifiedDiffFileSection[]): void {
  const renameSources = new Set<string>();
  const renameDests = new Set<string>();
  const creates = new Set<string>();
  const deletes = new Set<string>();
  const modifies = new Set<string>();

  for (const section of sections) {
    const kind = classifySection(section);
    if (kind === "rename") {
      const src = section.sourcePath!;
      const dst = section.destPath!;
      if (src === dst) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: "RENAME source and destination must differ."
        });
      }
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
      continue;
    }
    const path = section.relativePath;
    if (kind === "create") {
      if (creates.has(path) || modifies.has(path) || deletes.has(path) || renameDests.has(path)) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: `Conflicting CREATE on ${path}.`
        });
      }
      creates.add(path);
    } else if (kind === "delete") {
      if (deletes.has(path) || modifies.has(path) || creates.has(path) || renameSources.has(path)) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: `Conflicting DELETE on ${path}.`
        });
      }
      deletes.add(path);
    } else {
      if (modifies.has(path) || creates.has(path) || deletes.has(path)) {
        throw createPairMeshError({
          code: "pairmesh.proposal_invalid",
          message: `Conflicting MODIFY on ${path}.`
        });
      }
      modifies.add(path);
    }
  }

  const lower = new Map<string, string>();
  for (const section of sections) {
    for (const path of sectionAffectedPaths(section)) {
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

/**
 * Deterministic commit order: dependency topo, then CREATE→MODIFY→RENAME→DELETE.
 */
export function orderLifecycleSections(
  sections: UnifiedDiffFileSection[]
): UnifiedDiffFileSection[] {
  assertLifecycleConflicts(sections);

  const indexed = sections.map((section, index) => ({ section, index }));
  const n = indexed.length;
  const edges: Array<[number, number]> = [];

  const findModify = (path: string) =>
    indexed.find(
      (entry) => classifySection(entry.section) === "modify" && entry.section.relativePath === path
    );
  const findCreate = (path: string) =>
    indexed.find(
      (entry) => classifySection(entry.section) === "create" && entry.section.relativePath === path
    );
  const findDelete = (path: string) =>
    indexed.find(
      (entry) => classifySection(entry.section) === "delete" && entry.section.relativePath === path
    );

  for (const entry of indexed) {
    if (classifySection(entry.section) !== "rename") {
      continue;
    }
    const src = entry.section.sourcePath!;
    const dst = entry.section.destPath!;
    const modSrc = findModify(src);
    if (modSrc) {
      edges.push([modSrc.index, entry.index]);
    }
    const modDst = findModify(dst);
    if (modDst) {
      edges.push([entry.index, modDst.index]);
    }
    const createSrc = findCreate(src);
    if (createSrc) {
      edges.push([entry.index, createSrc.index]);
    }
    const delDst = findDelete(dst);
    if (delDst) {
      edges.push([delDst.index, entry.index]);
    }
  }

  const indegree = Array.from({ length: n }, () => 0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [from, to] of edges) {
    adj[from]!.push(to);
    indegree[to]! += 1;
  }

  const ready = indexed.filter((entry) => indegree[entry.index] === 0).sort(compareEntries);
  const ordered: UnifiedDiffFileSection[] = [];
  const remaining = new Set(indexed.map((entry) => entry.index));

  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next.section);
    remaining.delete(next.index);
    for (const to of adj[next.index]!) {
      indegree[to]! -= 1;
      if (indegree[to] === 0) {
        const entry = indexed.find((item) => item.index === to)!;
        ready.push(entry);
        ready.sort(compareEntries);
      }
    }
  }

  if (remaining.size > 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Lifecycle operations have a dependency cycle."
    });
  }

  return ordered;
}

function compareEntries(
  a: { section: UnifiedDiffFileSection; index: number },
  b: { section: UnifiedDiffFileSection; index: number }
): number {
  const rankA = LIFECYCLE_OP_RANK[classifySection(a.section)];
  const rankB = LIFECYCLE_OP_RANK[classifySection(b.section)];
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  const pathA = a.section.isRename ? a.section.destPath! : a.section.relativePath;
  const pathB = b.section.isRename ? b.section.destPath! : b.section.relativePath;
  if (pathA < pathB) {
    return -1;
  }
  if (pathA > pathB) {
    return 1;
  }
  return a.index - b.index;
}
