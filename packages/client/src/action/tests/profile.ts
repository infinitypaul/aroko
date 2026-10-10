import { createPairMeshError } from "@pairmesh/protocol";
import { access, constants, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizeForDigest, sha256Hex } from "../digest.js";
import type { PairMeshTestsConfig } from "../../local-config/schema.js";
import { assertProposalPathInsideWorkspace } from "../proposal/paths.js";
import { isShellHostBasename } from "../process/shell-host-policy.js";

/** Absolute PairMesh ceiling for any profile timeout (10 minutes). */
export const TESTS_RUN_ABSOLUTE_TIMEOUT_MS = 600_000;

/**
 * Narrow V1 allowlist of common test runners / package managers.
 * `npx` is excluded: it can fetch/install packages (current release forbids install).
 */
const EXECUTABLE_BASENAME_ALLOWLIST = new Set([
  "node",
  "nodejs",
  "pnpm",
  "npm",
  "yarn",
  "vitest",
  "php",
  "composer",
  "python",
  "python3",
  "pytest",
  "go",
  "cargo",
  "dotnet"
]);

const FORBIDDEN_REMOTE_PARAM_KEYS = new Set([
  "command",
  "executable",
  "args",
  "argv",
  "cwd",
  "env",
  "environment",
  "shell",
  "script",
  "path",
  "workingDirectory",
  "timeoutMs",
  "timeout",
  "profileDigest"
]);

const TRUSTED_FALLBACK_PATH_DIRS =
  process.platform === "win32" ? [] : ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];

export interface ResolvedTestProfile {
  name: string;
  /** Allowlisted basename from the profile config (not a path). */
  executableBasename: string;
  /**
   * Absolute realpath of the resolved executable — local spawn only.
   * Never include in remote ActionResult / audit payloads.
   */
  executableAbsolute: string;
  args: string[];
  cwdRelative: string;
  cwdAbsolute: string;
  timeoutMs: number;
  envOverrides: Record<string, string>;
  maxOutputBytes: number;
  digest: string;
}

export interface ResolveTestProfileOptions {
  name: string;
  testsConfig: PairMeshTestsConfig;
  workspaceRoot: string;
  /**
   * Override controlled PATH directories (tests / advanced receivers).
   * When omitted, directories come from process PATH minus workspace paths.
   */
  pathDirectories?: string[];
}

export function assertRemoteTestsRunParameters(parameters: Record<string, unknown>): {
  profileName: string;
} {
  for (const key of Object.keys(parameters)) {
    if (FORBIDDEN_REMOTE_PARAM_KEYS.has(key)) {
      throw createPairMeshError({
        code: "pairmesh.test_profile_invalid",
        message: `Remote tests.run must not supply '${key}'. Profile name only.`
      });
    }
    if (key !== "profile" && key !== "profileName") {
      throw createPairMeshError({
        code: "pairmesh.test_profile_invalid",
        message: `Unsupported tests.run parameter '${key}'. Only profile name is allowed.`
      });
    }
  }
  const raw = parameters.profile ?? parameters.profileName;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: "tests.run requires a profile name parameter."
    });
  }
  const profileName = raw.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(profileName)) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: "Invalid profile name."
    });
  }
  return { profileName };
}

export function computeProfileDigest(input: {
  name: string;
  executableBasename: string;
  /** sha256 of realpath — binds resolved identity without exposing the path. */
  resolvedExecutableIdentity: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  maxOutputBytes: number;
}): string {
  return sha256Hex(
    canonicalizeForDigest({
      name: input.name,
      executable: input.executableBasename,
      resolvedExecutableIdentity: input.resolvedExecutableIdentity,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      maxOutputBytes: input.maxOutputBytes
    })
  );
}

/**
 * Build PATH search directories that never include the receiver workspace
 * (blocks project-local binary shadowing for profile executable resolution).
 */
export function buildControlledPathDirectories(
  workspaceRoot: string,
  pathEnv: string | undefined = process.env.PATH
): string[] {
  const root = resolve(workspaceRoot);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  const seen = new Set<string>();
  const result: string[] = [];

  const consider = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "." || trimmed.startsWith(".")) {
      return;
    }
    let absolute: string;
    try {
      absolute = resolve(trimmed);
    } catch {
      return;
    }
    if (absolute === root || absolute.startsWith(rootWithSep)) {
      return;
    }
    if (seen.has(absolute)) {
      return;
    }
    seen.add(absolute);
    result.push(absolute);
  };

  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const part of (pathEnv ?? "").split(delimiter)) {
    consider(part);
  }
  for (const fallback of TRUSTED_FALLBACK_PATH_DIRS) {
    consider(fallback);
  }
  return result;
}

export async function resolveAllowlistedExecutable(input: {
  executableBasename: string;
  workspaceRoot: string;
  pathDirectories?: string[];
}): Promise<{ absolutePath: string; identityDigest: string }> {
  const name = input.executableBasename;
  const directories = input.pathDirectories ?? buildControlledPathDirectories(input.workspaceRoot);
  if (directories.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: "No controlled PATH directories available to resolve the profile executable."
    });
  }

  const candidates: string[] = [];
  for (const dir of directories) {
    candidates.push(join(dir, name));
    if (process.platform === "win32") {
      candidates.push(join(dir, `${name}.exe`));
      candidates.push(join(dir, `${name}.cmd`));
    }
  }

  const root = resolve(input.workspaceRoot);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const real = await realpath(candidate);
      if (real === root || real.startsWith(rootWithSep)) {
        throw createPairMeshError({
          code: "pairmesh.test_profile_invalid",
          message:
            "Resolved executable is inside the workspace. Project-local executable shadowing is not permitted in V1."
        });
      }
      const info = await stat(real);
      if (!info.isFile()) {
        continue;
      }
      return {
        absolutePath: real,
        identityDigest: sha256Hex(real)
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "pairmesh.test_profile_invalid"
      ) {
        throw error;
      }
      // not found / not executable — try next
    }
  }

  throw createPairMeshError({
    code: "pairmesh.test_profile_invalid",
    message: `Allowlisted executable '${name}' could not be resolved on the controlled PATH.`
  });
}

export async function resolveTestProfile(
  input: ResolveTestProfileOptions
): Promise<ResolvedTestProfile> {
  const profile = input.testsConfig.profiles[input.name];
  if (!profile) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_not_found",
      message: "Test profile not found."
    });
  }

  const executableName = basename(profile.executable.replace(/\\/g, "/"));
  if (isShellHostBasename(executableName)) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: "Shell hosts are not allowed as tests.run executables in V1."
    });
  }
  if (executableName.toLowerCase() === "npx") {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: "npx is not permitted for tests.run in the current Aroko release (package install/fetch risk)."
    });
  }
  if (!EXECUTABLE_BASENAME_ALLOWLIST.has(executableName.toLowerCase())) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: `Executable '${executableName}' is not on the V1 tests.run allowlist.`
    });
  }

  if (
    isAbsolute(profile.executable) ||
    profile.executable.includes("/") ||
    profile.executable.includes("\\")
  ) {
    throw createPairMeshError({
      code: "pairmesh.test_profile_invalid",
      message: "V1 profiles must use an allowlisted executable basename (not a path)."
    });
  }

  for (const arg of profile.args) {
    if (arg.includes("\0")) {
      throw createPairMeshError({
        code: "pairmesh.test_profile_invalid",
        message: "Profile args must not contain NUL."
      });
    }
  }

  const cwdRelative = profile.cwd?.trim() || ".";
  if (cwdRelative !== ".") {
    await assertProposalPathInsideWorkspace(input.workspaceRoot, cwdRelative);
  }
  const cwdAbsolute = resolve(input.workspaceRoot, cwdRelative === "." ? "." : cwdRelative);
  const root = resolve(input.workspaceRoot);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (cwdAbsolute !== root && !cwdAbsolute.startsWith(rootWithSep)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_path_denied",
      message: "Profile cwd escapes the project root."
    });
  }

  const resolvedExe = await resolveAllowlistedExecutable({
    executableBasename: executableName,
    workspaceRoot: input.workspaceRoot,
    pathDirectories: input.pathDirectories
  });

  const timeoutMs = Math.min(profile.timeoutMs, TESTS_RUN_ABSOLUTE_TIMEOUT_MS);
  const digest = computeProfileDigest({
    name: input.name,
    executableBasename: executableName,
    resolvedExecutableIdentity: resolvedExe.identityDigest,
    args: [...profile.args],
    cwd: cwdRelative === "." ? "." : cwdRelative,
    timeoutMs,
    env: profile.env ?? {},
    maxOutputBytes: profile.maxOutputBytes
  });

  return {
    name: input.name,
    executableBasename: executableName,
    executableAbsolute: resolvedExe.absolutePath,
    args: [...profile.args],
    cwdRelative: relative(root, cwdAbsolute).split(sep).join("/") || ".",
    cwdAbsolute,
    timeoutMs,
    envOverrides: { ...(profile.env ?? {}) },
    maxOutputBytes: profile.maxOutputBytes,
    digest
  };
}

export function isSessionAllowedProfile(
  testsConfig: PairMeshTestsConfig,
  profileName: string
): boolean {
  return testsConfig.sessionAllowedProfiles.includes(profileName);
}

/**
 * Minimal inherited env + receiver overrides. Strips PairMesh secrets.
 * PATH is filtered to exclude the workspace (same policy as executable resolve).
 */
export function buildChildEnvironment(
  overrides: Record<string, string>,
  options: { workspaceRoot: string; pathDirectories?: string[] }
): NodeJS.ProcessEnv {
  const inheritKeys = [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "NODE_ENV",
    "CI"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of inheritKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = options.pathDirectories ?? buildControlledPathDirectories(options.workspaceRoot);
  env.PATH = dirs.join(delimiter);
  if (process.platform === "win32") {
    env.Path = env.PATH;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (/^PAIRMESH_/i.test(key) || /TOKEN|SECRET|PASSWORD|BEARER|INVITE/i.test(key)) {
      throw createPairMeshError({
        code: "pairmesh.test_profile_invalid",
        message: `Profile env key '${key}' is not permitted.`
      });
    }
    if (key === "PATH" || key === "Path") {
      throw createPairMeshError({
        code: "pairmesh.test_profile_invalid",
        message: "Profile env must not override PATH."
      });
    }
    env[key] = value;
  }
  return env;
}

/** Exported for tests — V1 allowlist snapshot (npx excluded). */
export function listV1AllowedExecutableBasenames(): string[] {
  return [...EXECUTABLE_BASENAME_ALLOWLIST].sort();
}
