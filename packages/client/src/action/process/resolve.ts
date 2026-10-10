import { createPairMeshError } from "@pairmesh/protocol";
import { access, constants, realpath, readFile, stat, lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { buildControlledPathDirectories, buildChildEnvironment } from "../tests/profile.js";
import { canonicalizeForDigest, sha256Hex } from "../digest.js";
import type { PairMeshProcessExecutionConfig } from "../../local-config/schema.js";
import {
  assertNoShellHostInvocation,
  assertResolvedExecutableNotWindowsShellScript,
  isShellHostBasename,
  isWindowsShellScriptPath
} from "./shell-host-policy.js";

/** Absolute ceiling for any process.execute timeout (10 minutes). */
export const PROCESS_EXECUTE_ABSOLUTE_TIMEOUT_MS = 600_000;

/** Default retained output bytes per stream when config omitted. */
export const PROCESS_EXECUTE_DEFAULT_MAX_OUTPUT_BYTES = 262_144;

const FORBIDDEN_REMOTE_PARAM_KEYS = new Set([
  "command",
  "shell",
  "script",
  "env",
  "environment",
  "stdin",
  "tty",
  "path",
  "executableAbsolute",
  "resolvedExecutableAbsolute",
  "resolvedExecutableIdentity",
  "envPolicyDigest",
  "artifactId",
  "contentHash",
  "approval",
  "allow_session",
  "allowSession"
]);

export interface ResolvedProcessExecutable {
  basename: string;
  absolutePath: string;
  /** sha256(canonicalRealpath + "\\0" + contentSha256) */
  identity: string;
  contentSha256: string;
  realpathCanonical: string;
}

export interface BoundProcessExecution {
  executableBasename: string;
  args: string[];
  cwdRelative: string;
  cwdAbsolute: string;
  timeoutMs: number;
  maxOutputBytes: number;
  envPolicyDigest: string;
  envOverrides: Record<string, string>;
  resolved: ResolvedProcessExecutable;
  workspaceIdentity: string;
}

export function assertRemoteProcessExecuteParameters(parameters: Record<string, unknown>): {
  executableBasename: string;
  args: string[];
  cwdRelative: string;
  timeoutMs?: number;
} {
  for (const key of Object.keys(parameters)) {
    if (FORBIDDEN_REMOTE_PARAM_KEYS.has(key)) {
      throw createPairMeshError({
        code: "pairmesh.process_request_invalid",
        message: `Remote process.execute must not supply '${key}'.`
      });
    }
  }

  const allowed = new Set(["executable", "args", "cwd", "timeoutMs", "timeout"]);
  for (const key of Object.keys(parameters)) {
    if (!allowed.has(key)) {
      throw createPairMeshError({
        code: "pairmesh.process_request_invalid",
        message: `Unsupported process.execute parameter '${key}'.`
      });
    }
  }

  const rawExe = parameters.executable;
  if (typeof rawExe !== "string" || rawExe.trim().length === 0) {
    throw createPairMeshError({
      code: "pairmesh.process_request_invalid",
      message: "process.execute requires an executable basename."
    });
  }
  const executableBasename = rawExe.trim();
  if (
    isAbsolute(executableBasename) ||
    executableBasename.includes("/") ||
    executableBasename.includes("\\") ||
    executableBasename.includes("~") ||
    executableBasename.includes("..")
  ) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: "process.execute executable must be a basename (not a path)."
    });
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(executableBasename)) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: "Invalid executable basename."
    });
  }

  const rawArgs = parameters.args;
  let args: string[] = [];
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs) || !rawArgs.every((entry) => typeof entry === "string")) {
      throw createPairMeshError({
        code: "pairmesh.process_request_invalid",
        message: "process.execute args must be a string array."
      });
    }
    if (rawArgs.length > 50) {
      throw createPairMeshError({
        code: "pairmesh.process_request_invalid",
        message: "process.execute supports at most 50 arguments."
      });
    }
    for (const arg of rawArgs) {
      if (arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 500) {
        throw createPairMeshError({
          code: "pairmesh.process_request_invalid",
          message: "process.execute argument is invalid."
        });
      }
    }
    args = [...rawArgs];
  }

  // R22-2: shell hosts + wrapper→shell invocations fail closed.
  // Non-shell interpreters (python3 -c, node -e) remain ordinary argv.
  assertNoShellHostInvocation({ executableBasename, args });

  const cwdRaw =
    typeof parameters.cwd === "string" && parameters.cwd.trim().length > 0
      ? parameters.cwd.trim()
      : ".";
  if (cwdRaw.startsWith("~") || isAbsolute(cwdRaw)) {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd must be workspace-relative."
    });
  }

  let timeoutMs: number | undefined;
  const timeoutRaw = parameters.timeoutMs ?? parameters.timeout;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1_000) {
      throw createPairMeshError({
        code: "pairmesh.process_request_invalid",
        message: "process.execute timeoutMs must be an integer >= 1000."
      });
    }
    timeoutMs = timeoutRaw;
  }

  return { executableBasename, args, cwdRelative: cwdRaw, timeoutMs };
}

export function computeEnvPolicyDigest(envOverrides: Record<string, string>): string {
  return sha256Hex(canonicalizeForDigest({ env: envOverrides }));
}

export function computeWorkspaceIdentity(workspaceRoot: string): string {
  // Bind the configured path string; execute-time revalidation uses the same
  // configured root. Symlink canonicalization is enforced in validateProcessCwd.
  return sha256Hex(resolve(workspaceRoot));
}

export async function computeExecutableIdentity(absoluteRealpath: string): Promise<{
  identity: string;
  contentSha256: string;
  realpathCanonical: string;
}> {
  const realpathCanonical = absoluteRealpath.split(sep).join("/");
  const content = await readFile(absoluteRealpath);
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const identity = sha256Hex(`${realpathCanonical}\0${contentSha256}`);
  return { identity, contentSha256, realpathCanonical };
}

export async function resolveProcessExecutable(input: {
  executableBasename: string;
  workspaceRoot: string;
  pathDirectories?: string[];
}): Promise<ResolvedProcessExecutable> {
  const name = basename(input.executableBasename);
  assertNoShellHostInvocation({ executableBasename: name, args: [] });

  const directories = input.pathDirectories ?? buildControlledPathDirectories(input.workspaceRoot);
  if (directories.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: "No controlled PATH directories available to resolve the executable."
    });
  }

  const candidates: string[] = [];
  for (const dir of directories) {
    candidates.push(join(dir, name));
    if (process.platform === "win32") {
      candidates.push(join(dir, `${name}.exe`));
      // R22-2: never consider .cmd/.bat via PATHEXT-style resolution.
    }
  }

  const root = await realpath(resolve(input.workspaceRoot));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;

  for (const candidate of candidates) {
    try {
      if (isWindowsShellScriptPath(candidate)) {
        continue;
      }
      await access(candidate, constants.X_OK);
      const real = await realpath(candidate);
      assertResolvedExecutableNotWindowsShellScript(real);
      if (real === root || real.startsWith(rootWithSep)) {
        throw createPairMeshError({
          code: "pairmesh.process_executable_invalid",
          message:
            "Resolved executable is inside the workspace. Project-local executable shadowing is not permitted."
        });
      }
      const info = await stat(real);
      if (!info.isFile()) {
        continue;
      }
      const identity = await computeExecutableIdentity(real);
      return {
        basename: name,
        absolutePath: real,
        identity: identity.identity,
        contentSha256: identity.contentSha256,
        realpathCanonical: identity.realpathCanonical
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "pairmesh.process_executable_invalid"
      ) {
        throw error;
      }
    }
  }

  throw createPairMeshError({
    code: "pairmesh.process_executable_invalid",
    message: `Executable '${name}' could not be resolved on the controlled PATH.`
  });
}

export async function validateProcessCwd(input: {
  workspaceRoot: string;
  cwdRelative: string;
  /** When set, require the confined relative path to match the approved binding. */
  expectedCwdRelative?: string;
}): Promise<{ cwdRelative: string; cwdAbsolute: string }> {
  const cwdRelative = input.cwdRelative.trim() || ".";
  if (cwdRelative.startsWith("~") || isAbsolute(cwdRelative)) {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd must be workspace-relative."
    });
  }
  // Lexical refuse before any filesystem follow.
  const segments = cwdRelative === "." ? [] : cwdRelative.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === ".." || segment === "") {
      throw createPairMeshError({
        code: "pairmesh.boundary_violation",
        message: "process.execute cwd escapes the project workspace."
      });
    }
  }

  let root: string;
  try {
    root = await realpath(resolve(input.workspaceRoot));
  } catch {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute workspace root is not resolvable."
    });
  }
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  const cwdAbsolute = resolve(root, cwdRelative === "." ? "." : cwdRelative);
  if (cwdAbsolute !== root && !cwdAbsolute.startsWith(rootWithSep)) {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd escapes the project workspace."
    });
  }

  let realCwd = cwdAbsolute;
  try {
    realCwd = await realpath(cwdAbsolute);
  } catch {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd does not exist."
    });
  }
  if (realCwd !== root && !realCwd.startsWith(rootWithSep)) {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd escapes the project workspace."
    });
  }

  // Ancestor walk: any symlink whose realpath escapes the workspace fails closed.
  let cursor = cwdAbsolute;
  while (cursor.startsWith(rootWithSep) || cursor === root) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        const linkReal = await realpath(cursor);
        if (linkReal !== root && !linkReal.startsWith(rootWithSep)) {
          throw createPairMeshError({
            code: "pairmesh.boundary_violation",
            message: "process.execute cwd resolves through a symlink outside the project workspace."
          });
        }
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
      // ENOENT mid-walk: continue upward
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

  const rel = relative(root, realCwd).split(sep).join("/") || ".";
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd escapes the project workspace."
    });
  }
  if (input.expectedCwdRelative !== undefined && rel !== input.expectedCwdRelative) {
    throw createPairMeshError({
      code: "pairmesh.boundary_violation",
      message: "process.execute cwd no longer matches the approved relative path."
    });
  }
  return { cwdRelative: rel, cwdAbsolute: realCwd };
}

export async function bindProcessExecution(input: {
  parameters: Record<string, unknown>;
  workspaceRoot: string;
  processConfig: PairMeshProcessExecutionConfig;
  pathDirectories?: string[];
}): Promise<BoundProcessExecution> {
  const remote = assertRemoteProcessExecuteParameters(input.parameters);
  const resolved = await resolveProcessExecutable({
    executableBasename: remote.executableBasename,
    workspaceRoot: input.workspaceRoot,
    pathDirectories: input.pathDirectories
  });
  const cwd = await validateProcessCwd({
    workspaceRoot: input.workspaceRoot,
    cwdRelative: remote.cwdRelative
  });

  const maxTimeout = Math.min(
    input.processConfig.maxTimeoutMs,
    PROCESS_EXECUTE_ABSOLUTE_TIMEOUT_MS
  );
  const requested = remote.timeoutMs ?? input.processConfig.defaultTimeoutMs ?? 120_000;
  const timeoutMs = Math.min(Math.max(requested, 1_000), maxTimeout);
  const maxOutputBytes = Math.min(Math.max(input.processConfig.maxOutputBytes, 1_024), 2_000_000);

  // Validate receiver env overrides using the same secret-key refusal as tests.run.
  buildChildEnvironment(input.processConfig.env ?? {}, {
    workspaceRoot: input.workspaceRoot,
    pathDirectories: input.pathDirectories
  });

  const envOverrides = { ...(input.processConfig.env ?? {}) };
  return {
    executableBasename: resolved.basename,
    args: remote.args,
    cwdRelative: cwd.cwdRelative,
    cwdAbsolute: cwd.cwdAbsolute,
    timeoutMs,
    maxOutputBytes,
    envPolicyDigest: computeEnvPolicyDigest(envOverrides),
    envOverrides,
    resolved,
    workspaceIdentity: computeWorkspaceIdentity(input.workspaceRoot)
  };
}

/** @deprecated Prefer isShellHostBasename from shell-host-policy. */
export function isShellInterpreterBasename(name: string): boolean {
  return isShellHostBasename(name);
}
