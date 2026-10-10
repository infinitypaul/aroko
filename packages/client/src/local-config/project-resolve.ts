import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { findProjectConfigFile, runtimeFilePath } from "./paths.js";

export class PairMeshProjectNotFoundError extends Error {
  constructor() {
    super("No Aroko project found.\n\nRun:\n  aroko init\n\nfrom your project root.");
    this.name = "PairMeshProjectNotFoundError";
  }
}

export interface ResolvePairMeshProjectRootOptions {
  explicitWorkspace?: string;
  cwd?: string;
}

/**
 * Multi-candidate project discovery for trusted local clients (CLI helpers,
 * future Desktop, multi-root editors). Never assume `workspaceFolders[0]` alone.
 *
 * Precedence:
 * 1. PAIRMESH_PROJECT_ROOT / envProjectRoot when it contains `.pairmesh/config.json`
 * 2. Nearest `.pairmesh/config.json` from each startDir (caller-ordered)
 * 3. Prefer a candidate with live Control runtime (`controlUrl` + `controlToken`)
 * 4. Otherwise the first discovered initialized project
 */
export interface ResolvePairMeshProjectAmongOptions {
  /** Absolute paths to try as walk-up start points, in preference order. */
  startDirs: string[];
  /** Optional env override (PAIRMESH_PROJECT_ROOT). */
  envProjectRoot?: string;
  /** Returns true when a project root has a usable Control runtime endpoint. */
  hasControlRuntime?: (projectRoot: string) => Promise<boolean>;
}

export async function findPairMeshProjectRoot(startDir: string): Promise<string | null> {
  const configPath = await findProjectConfigFile(resolve(startDir));
  if (!configPath) {
    return null;
  }
  return resolve(dirname(dirname(configPath)));
}

export async function resolvePairMeshProjectRoot(
  options: ResolvePairMeshProjectRootOptions = {}
): Promise<string> {
  const explicit = options.explicitWorkspace?.trim();
  if (explicit) {
    return resolve(explicit);
  }

  const envRoot = process.env.PAIRMESH_PROJECT_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }

  const projectRoot = await findPairMeshProjectRoot(options.cwd ?? process.cwd());
  if (!projectRoot) {
    throw new PairMeshProjectNotFoundError();
  }

  return projectRoot;
}

export function resolveInitWorkspace(explicitWorkspace: string | undefined): string {
  const value = explicitWorkspace?.trim();
  if (value) {
    return resolve(value);
  }
  return resolve(process.cwd());
}

/**
 * Build preferred start directories for multi-root / editor-style discovery.
 * Active file directory first, then its owning workspace folder, then remaining roots.
 * Callers must not pass only `workspaceFolders[0]` without considering the active file.
 */
export function buildProjectDiscoveryStartDirs(input: {
  activeFilePath?: string;
  workspaceFolderPaths: string[];
}): string[] {
  const folders = input.workspaceFolderPaths.map((folder) => resolve(folder));
  const starts: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const resolved = resolve(value);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    starts.push(resolved);
  };

  if (input.activeFilePath) {
    const activeDir = dirname(resolve(input.activeFilePath));
    push(activeDir);
    const owning = folders.find(
      (folder) => activeDir === folder || activeDir.startsWith(folder + sep)
    );
    push(owning);
  }

  for (const folder of folders) {
    push(folder);
  }

  return starts;
}

export async function projectHasControlRuntime(projectRoot: string): Promise<boolean> {
  try {
    const raw = await readFile(runtimeFilePath(projectRoot), "utf8");
    const info = JSON.parse(raw) as { controlUrl?: string; controlToken?: string };
    return Boolean(info.controlUrl && info.controlToken);
  } catch {
    return false;
  }
}

export async function resolvePairMeshProjectAmong(
  options: ResolvePairMeshProjectAmongOptions
): Promise<string | null> {
  const envRoot = options.envProjectRoot?.trim();
  if (envRoot) {
    const resolved = resolve(envRoot);
    try {
      await access(join(resolved, ".pairmesh", "config.json"));
      return resolved;
    } catch {
      // fall through to discovery
    }
  }

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const startDir of options.startDirs) {
    if (!startDir?.trim()) {
      continue;
    }
    const root = await findPairMeshProjectRoot(startDir);
    if (!root || seen.has(root)) {
      continue;
    }
    seen.add(root);
    candidates.push(root);
  }

  if (candidates.length === 0) {
    return null;
  }

  const hasRuntime = options.hasControlRuntime ?? projectHasControlRuntime;
  for (const root of candidates) {
    if (await hasRuntime(root)) {
      return root;
    }
  }

  return candidates[0] ?? null;
}
