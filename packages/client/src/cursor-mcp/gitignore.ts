import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PAIRMESH_GITIGNORE_ENTRY = ".pairmesh/";

export interface GitignoreResult {
  updated: boolean;
  warning?: string;
}

export async function ensurePairMeshGitignore(workspace: string): Promise<GitignoreResult> {
  const gitignorePath = join(resolve(workspace), ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    await writeFile(gitignorePath, `${PAIRMESH_GITIGNORE_ENTRY}\n`, "utf8");
    return { updated: true };
  }

  if (gitignoreContainsPairMesh(existing)) {
    return { updated: false, ...(await trackedPairMeshWarning(workspace)) };
  }

  const separator = existing.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, `${existing}${separator}${PAIRMESH_GITIGNORE_ENTRY}\n`, "utf8");
  return { updated: true, ...(await trackedPairMeshWarning(workspace)) };
}

function gitignoreContainsPairMesh(content: string): boolean {
  return content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === ".pairmesh" || line === ".pairmesh/" || line === "/.pairmesh/");
}

async function trackedPairMeshWarning(workspace: string): Promise<{ warning?: string }> {
  const gitDir = join(resolve(workspace), ".git");
  try {
    await access(gitDir);
  } catch {
    return {};
  }

  try {
    const { stdout } = await execFileAsync("git", ["ls-files", ".pairmesh"], {
      cwd: resolve(workspace)
    });
    if (stdout.trim().length === 0) {
      return {};
    }
  } catch {
    return {};
  }

  return {
    warning:
      "Warning: .pairmesh contains files already tracked by Git.\n\nPairMesh added .pairmesh/ to .gitignore, but already tracked files must be removed from Git tracking manually."
  };
}
