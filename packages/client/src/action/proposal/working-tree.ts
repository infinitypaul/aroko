import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".pairmesh", "dist", "coverage", ".turbo"]);

/**
 * Deterministic working-tree digest for prove-no-mutation tests.
 * Includes tracked-like file contents under the workspace (skips common VCS/deps dirs).
 * Also returns a sorted relative path listing for status-like comparison.
 */
export async function digestWorkingTree(workspaceRoot: string): Promise<{
  contentDigest: string;
  paths: string[];
}> {
  const root = await realpath(resolve(workspaceRoot));
  const files: string[] = [];
  await walk(root, root, files);
  files.sort();
  const hash = createHash("sha256");
  for (const absolute of files) {
    const rel = relative(root, absolute).split(sep).join("/");
    const bytes = await readFile(absolute);
    hash.update(rel);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return {
    contentDigest: hash.digest("hex"),
    paths: files.map((absolute) => relative(root, absolute).split(sep).join("/"))
  };
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Conservative: record symlink identity without following (target path text).
      const rel = relative(root, absolute).split(sep).join("/");
      out.push(absolute);
      void rel;
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, absolute, out);
      continue;
    }
    if (entry.isFile()) {
      const info = await stat(absolute);
      if (info.isFile()) {
        out.push(absolute);
      }
    }
  }
}
