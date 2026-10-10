import { createPairMeshError } from "@pairmesh/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeInspectionOutput } from "../../coding-agent/sanitize.js";
import { buildChildEnvironment } from "../tests/profile.js";

export interface ProcessRunnerResult {
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

export interface StructuredProcessRunInput {
  executableAbsolute: string;
  args: string[];
  cwdAbsolute: string;
  timeoutMs: number;
  maxOutputBytes: number;
  envOverrides: Record<string, string>;
  workspaceRoot: string;
  pathDirectories?: string[];
  abortSignal?: AbortSignal;
}

export type StructuredProcessRunner = (
  input: StructuredProcessRunInput
) => Promise<ProcessRunnerResult>;

/**
 * Direct argv spawn with shell:false. Never constructs shell command strings.
 * stdin closed. POSIX process-group SIGTERM→SIGKILL on timeout/cancel.
 */
export async function runStructuredProcess(
  input: StructuredProcessRunInput
): Promise<ProcessRunnerResult> {
  if (input.abortSignal?.aborted) {
    throw createPairMeshError({
      code: "pairmesh.action_cancelled",
      message: "process.execute cancelled before process start."
    });
  }

  const env = buildChildEnvironment(input.envOverrides, {
    workspaceRoot: input.workspaceRoot,
    pathDirectories: input.pathDirectories
  });
  // Harden: never inherit SSH agent / common secret sockets even if baseline grows.
  delete env.SSH_AUTH_SOCK;
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.NPM_TOKEN;
  delete env.DATABASE_URL;

  const started = Date.now();
  let timedOut = false;
  let cancelled = false;
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const max = input.maxOutputBytes;

  const child: ChildProcess = spawn(input.executableAbsolute, input.args, {
    cwd: input.cwdAbsolute,
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
    timeoutHandle = setTimeout(() => resolve("timeout"), input.timeoutMs);
  });

  const abortHandler = () => {
    cancelled = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 2_000).unref?.();
  };
  input.abortSignal?.addEventListener("abort", abortHandler, { once: true });

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
        code: "pairmesh.process_execution_timeout",
        message: `process.execute timed out after ${input.timeoutMs}ms.`
      });
    }

    const { code, signal } = raced.value;
    if (cancelled) {
      throw createPairMeshError({
        code: "pairmesh.action_cancelled",
        message: "process.execute cancelled during execution."
      });
    }

    const sanitizeOpts = { workspace: input.workspaceRoot };
    return {
      exitCode: code,
      signal: signal ?? null,
      timedOut,
      cancelled,
      durationMs: Date.now() - started,
      stdout: sanitizeProcessOutput(sanitizeInspectionOutput(stdout, sanitizeOpts)),
      stderr: sanitizeProcessOutput(sanitizeInspectionOutput(stderr, sanitizeOpts)),
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
      error instanceof Error ? error.message.slice(0, 200) : "Failed to spawn process.";
    throw createPairMeshError({
      code: "pairmesh.process_execution_failed",
      message: `Failed to spawn process.execute: ${message}`
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    input.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

/** Strip ANSI / common terminal control sequences for History / Control UI. */
export function sanitizeProcessOutput(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- intentional ANSI CSI strip
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex -- intentional OSC / BEL strip
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex -- intentional C0 control strip
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
