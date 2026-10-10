import { createPairMeshError } from "@pairmesh/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeInspectionOutput } from "../../coding-agent/sanitize.js";
import { buildChildEnvironment, type ResolvedTestProfile } from "./profile.js";

export interface ProfileProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type ProfileProcessRunner = (
  profile: ResolvedTestProfile,
  options: {
    abortSignal?: AbortSignal;
    workspaceRoot: string;
    pathDirectories?: string[];
  }
) => Promise<ProfileProcessResult>;

/**
 * Direct argv spawn with shell:false using the resolved absolute executable.
 * Never constructs shell command strings. Never prepends workspace bins to PATH.
 */
export async function runProfileProcess(
  profile: ResolvedTestProfile,
  options: {
    abortSignal?: AbortSignal;
    workspaceRoot: string;
    pathDirectories?: string[];
  }
): Promise<ProfileProcessResult> {
  if (options.abortSignal?.aborted) {
    throw createPairMeshError({
      code: "pairmesh.action_cancelled",
      message: "tests.run cancelled before process start."
    });
  }

  const env = buildChildEnvironment(profile.envOverrides, {
    workspaceRoot: options.workspaceRoot,
    pathDirectories: options.pathDirectories
  });

  const started = Date.now();
  let timedOut = false;
  let cancelled = false;
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const max = profile.maxOutputBytes;

  const child: ChildProcess = spawn(profile.executableAbsolute, profile.args, {
    cwd: profile.cwdAbsolute,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  const appendBounded = (chunk: Buffer, which: "stdout" | "stderr"): void => {
    const text = chunk.toString("utf8");
    if (which === "stdout") {
      if (Buffer.byteLength(stdout, "utf8") >= max) {
        stdoutTruncated = true;
        return;
      }
      const room = max - Buffer.byteLength(stdout, "utf8");
      stdout += text.slice(0, Math.max(0, room));
      if (Buffer.byteLength(text, "utf8") > room) {
        stdoutTruncated = true;
      }
    } else {
      if (Buffer.byteLength(stderr, "utf8") >= max) {
        stderrTruncated = true;
        return;
      }
      const room = max - Buffer.byteLength(stderr, "utf8");
      stderr += text.slice(0, Math.max(0, room));
      if (Buffer.byteLength(text, "utf8") > room) {
        stderrTruncated = true;
      }
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => appendBounded(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => appendBounded(chunk, "stderr"));

  const killTree = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) {
      return;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    }
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), profile.timeoutMs);
  });

  const abortHandler = () => {
    cancelled = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 2_000).unref?.();
  };
  options.abortSignal?.addEventListener("abort", abortHandler, { once: true });

  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const raced = await Promise.race([
      exitPromise.then((value) => ({ kind: "exit" as const, value })),
      timeoutPromise.then(() => ({ kind: "timeout" as const }))
    ]);

    if (raced.kind === "timeout") {
      timedOut = true;
      killTree("SIGTERM");
      await sleep(2_000);
      if (child.exitCode === null && child.signalCode === null) {
        killTree("SIGKILL");
      }
      await exitPromise.catch(() => undefined);
      throw createPairMeshError({
        code: "pairmesh.test_execution_timeout",
        message: `tests.run profile '${profile.name}' timed out after ${profile.timeoutMs}ms.`
      });
    }

    const { code, signal } = raced.value;
    if (cancelled) {
      throw createPairMeshError({
        code: "pairmesh.action_cancelled",
        message: "tests.run cancelled during execution."
      });
    }

    const sanitizeOpts = { workspace: options.workspaceRoot };
    return {
      exitCode: code,
      signal: signal ?? null,
      timedOut,
      cancelled,
      durationMs: Date.now() - started,
      stdout: sanitizeInspectionOutput(stdout, sanitizeOpts),
      stderr: sanitizeInspectionOutput(stderr, sanitizeOpts),
      stdoutTruncated,
      stderrTruncated
    };
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
    const message =
      error instanceof Error ? error.message.slice(0, 200) : "Failed to spawn test process.";
    throw createPairMeshError({
      code: "pairmesh.test_execution_failed",
      message: `Failed to spawn tests.run process: ${message}`
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    options.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
