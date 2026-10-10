import { createPairMeshError } from "@pairmesh/protocol";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, posix, relative, resolve, sep } from "node:path";

const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /^\.envrc$/i,
  /credentials/i,
  /secret/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^id_ecdsa$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /^auth\.json$/i,
  /^token$/i,
  /^tokens\.json$/i
];

export const SENSITIVE_PATH_SEGMENTS = new Set([".git", "node_modules", ".pairmesh"]);

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = segments[segments.length - 1] ?? normalized;
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Normalize a proposal path to a project-relative POSIX path.
 * Rejects absolute paths, traversal, NUL, and empty paths.
 */
export function normalizeProposalRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Proposal path is empty or contains NUL."
    });
  }
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("//")) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Absolute proposal paths are not allowed."
    });
  }
  const posixPath = trimmed.replace(/\\/g, "/");
  if (posixPath.split("/").includes("..")) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Proposal path must not contain '..'."
    });
  }
  const collapsed = posix.normalize(posixPath).replace(/^(\.\/)+/, "");
  if (!collapsed || collapsed === "." || collapsed.startsWith("../") || collapsed === "..") {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Proposal path escapes the project root."
    });
  }
  if (isSensitiveRelativePath(collapsed)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Proposal targets a sensitive path denied by receiver policy."
    });
  }
  return collapsed;
}

export async function assertProposalPathInsideWorkspace(
  workspaceRoot: string,
  relativePath: string
): Promise<string> {
  const normalized = normalizeProposalRelativePath(relativePath);
  let root: string;
  try {
    root = await realpath(resolve(workspaceRoot));
  } catch {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Workspace root is not resolvable."
    });
  }
  const candidate = resolve(root, ...normalized.split("/"));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Resolved proposal path escapes the project root."
    });
  }

  // Walk ancestors: reject symlink escapes for existing path components.
  let cursor = candidate;
  while (cursor.startsWith(rootWithSep) || cursor === root) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        const real = await realpath(cursor);
        if (real !== root && !real.startsWith(rootWithSep)) {
          throw createPairMeshError({
            code: "pairmesh.proposal_path_denied",
            message: "Proposal path resolves through a symlink outside the project root."
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Parent may not exist yet (new file); continue upward.
      } else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code: unknown }).code === "string" &&
        (error as { code: string }).code.startsWith("pairmesh.")
      ) {
        throw error;
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // ignore other lstat noise for missing intermediates
      }
    }
    if (cursor === root) {
      break;
    }
    const parent = resolve(cursor, "..");
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  const relativePosix = relative(root, candidate).split(sep).join("/");
  if (!relativePosix || relativePosix.startsWith("..") || isAbsolute(relativePosix)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Proposal path is not project-relative after resolution."
    });
  }
  return normalize(relativePosix).split(sep).join("/");
}

/**
 * R22-3: revalidate confinement immediately before a filesystem mutation.
 * Returns the confined relative path and a freshly resolved absolute path.
 */
export async function assertCommitPathConfined(
  workspaceRoot: string,
  relativePath: string
): Promise<{ relativePath: string; absolutePath: string }> {
  const confined = await assertProposalPathInsideWorkspace(workspaceRoot, relativePath);
  if (confined !== relativePath) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Commit path no longer matches the approved relative path after confinement."
    });
  }
  const root = await realpath(resolve(workspaceRoot));
  const absolutePath = resolve(root, ...confined.split("/"));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSep)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Resolved apply path escapes the project root."
    });
  }
  return { relativePath: confined, absolutePath };
}
