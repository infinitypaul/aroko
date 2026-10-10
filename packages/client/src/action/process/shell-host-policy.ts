/**
 * R22-2 — Authoritative process.execute / tests.run shell-host policy.
 *
 * Aroko is NOT a sandbox. Approved programs run as the receiver OS user.
 * This module only enforces the narrower R4 promise: Aroko must not permit a
 * shell host / shell-wrapper path while claiming shell=false.
 *
 * General-purpose interpreters (node -e, python -c, …) remain allowed when
 * explicitly approved — they are not shell hosts.
 */
import { createPairMeshError } from "@pairmesh/protocol";
import { basename, extname } from "node:path";

/** Direct shell / shell-like hosts refused as process.execute / tests.run executables. */
export const SHELL_HOST_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "hush",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe"
]);

/** BusyBox/toybox applets that are shell hosts. */
const BUSYBOX_SHELL_APPLETS = new Set(["sh", "ash", "bash", "hush", "ksh"]);

/**
 * Wrappers that can place a shell host in argv. Analyzed for shell-target
 * invocation; benign non-shell uses remain allowed.
 */
const SHELL_INVOCATION_WRAPPERS = new Set([
  "env",
  "busybox",
  "toybox",
  "xargs",
  "nohup",
  "setsid",
  "nice",
  "stdbuf",
  "timeout",
  "time",
  "ionice"
]);

/** Windows script extensions that imply cmd.exe / shell semantics under Node. */
export const WINDOWS_SHELL_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat"]);

export function normalizeExecutableBasename(name: string): string {
  return basename(name.trim().replace(/\\/g, "/")).toLowerCase();
}

export function isShellHostBasename(name: string): boolean {
  const base = normalizeExecutableBasename(name);
  if (SHELL_HOST_BASENAMES.has(base)) {
    return true;
  }
  // cmd.com etc.
  if (base === "cmd.com") {
    return true;
  }
  return false;
}

export function isWindowsShellScriptPath(absoluteOrName: string): boolean {
  const ext = extname(absoluteOrName).toLowerCase();
  return WINDOWS_SHELL_SCRIPT_EXTENSIONS.has(ext);
}

/**
 * Classify whether executable+argv would invoke a banned shell host,
 * including common wrapper forms (env, busybox, …).
 */
export function assertNoShellHostInvocation(input: {
  executableBasename: string;
  args?: string[];
}): void {
  const exe = normalizeExecutableBasename(input.executableBasename);
  const args = input.args ?? [];

  if (isShellHostBasename(exe)) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: "Shell hosts are not permitted as process.execute executables (shell=false)."
    });
  }

  // `script` defaults to an interactive shell and `-c` typically runs via sh -c.
  if (exe === "script") {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message:
        "The 'script' utility is not permitted for process.execute (shell-host / shell-command semantics)."
    });
  }

  // osascript is an AppleScript interpreter (like node), not a shell host — not banned here.

  if (isWindowsShellScriptPath(exe)) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: "Windows .cmd/.bat scripts are not permitted for process.execute (shell semantics)."
    });
  }

  if (!SHELL_INVOCATION_WRAPPERS.has(exe)) {
    return;
  }

  const target = resolveWrapperCommandTarget(exe, args);
  if (target && isShellHostBasename(target)) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: `Wrapper '${exe}' must not invoke shell host '${normalizeExecutableBasename(target)}'.`
    });
  }

  // busybox/toybox: applet is the first positional; also covered by resolveWrapperCommandTarget
  if (
    (exe === "busybox" || exe === "toybox") &&
    target &&
    BUSYBOX_SHELL_APPLETS.has(normalizeExecutableBasename(target))
  ) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message: `BusyBox/toybox applet '${normalizeExecutableBasename(target)}' is a shell host.`
    });
  }
}

/**
 * Resolve the command/applet a wrapper would run, or null if undetermined
 * (benign / no command yet). Fail-closed callers only reject when the target
 * is a known shell host.
 */
export function resolveWrapperCommandTarget(
  wrapperBasename: string,
  args: string[]
): string | null {
  const wrapper = normalizeExecutableBasename(wrapperBasename);
  if (wrapper === "env") {
    return parseEnvCommandTarget(args);
  }
  if (wrapper === "busybox" || wrapper === "toybox") {
    return parseBusyboxApplet(args);
  }
  if (
    wrapper === "xargs" ||
    wrapper === "nohup" ||
    wrapper === "setsid" ||
    wrapper === "nice" ||
    wrapper === "stdbuf" ||
    wrapper === "timeout" ||
    wrapper === "time" ||
    wrapper === "ionice"
  ) {
    return parseLeadingCommandTarget(args, wrapper);
  }
  return null;
}

function parseEnvCommandTarget(args: string[]): string | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg.startsWith("-")) {
      // Options that take a value
      if (
        arg === "-u" ||
        arg === "-C" ||
        arg === "-S" ||
        arg === "--unset" ||
        arg === "--chdir" ||
        arg === "--split-string"
      ) {
        i += 2;
        continue;
      }
      if (
        arg.startsWith("--unset=") ||
        arg.startsWith("--chdir=") ||
        arg.startsWith("--split-string=")
      ) {
        i += 1;
        continue;
      }
      // -i, -0, -v, long flags without values
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      i += 1;
      continue;
    }
    break;
  }
  return args[i] ?? null;
}

function parseBusyboxApplet(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function parseLeadingCommandTarget(args: string[], wrapper: string): string | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    // timeout / nice / stdbuf often take -n N / -s SIGNAL etc.
    if (
      (wrapper === "timeout" &&
        (arg === "-s" || arg === "-k" || arg === "--signal" || arg === "--kill-after")) ||
      (wrapper === "nice" && (arg === "-n" || arg === "--adjustment")) ||
      (wrapper === "stdbuf" && (arg === "-i" || arg === "-o" || arg === "-e")) ||
      (wrapper === "xargs" &&
        (arg === "-I" ||
          arg === "-i" ||
          arg === "-E" ||
          arg === "-e" ||
          arg === "-n" ||
          arg === "-P" ||
          arg === "-s" ||
          arg === "--replace" ||
          arg === "--max-args")) ||
      (wrapper === "ionice" && (arg === "-c" || arg === "-n" || arg === "-p"))
    ) {
      i += 2;
      continue;
    }
    if (arg.includes("=")) {
      i += 1;
      continue;
    }
    i += 1;
  }
  // timeout DURATION command — first positional may be duration
  if (wrapper === "timeout" && i < args.length && /^\d/.test(args[i]!)) {
    i += 1;
  }
  return args[i] ?? null;
}

/** Refuse resolved absolute paths that are Windows shell scripts. */
export function assertResolvedExecutableNotWindowsShellScript(absolutePath: string): void {
  if (isWindowsShellScriptPath(absolutePath)) {
    throw createPairMeshError({
      code: "pairmesh.process_executable_invalid",
      message:
        "Resolved executable is a Windows .cmd/.bat script; refused to avoid cmd.exe shell semantics."
    });
  }
}
