
import { spawn, type ChildProcess } from "node:child_process";
import { createCodingAgentError } from "./types.js";

/** Soft bound for retained stdout/stderr strings (20 MiB each). */
export const MAX_STREAM_CAPTURE_BYTES = 20 * 1024 * 1024;

export interface StreamingProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface StreamingProcessInput {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Optional env overlay; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  onSpawn?: (child: ChildProcess) => void;
  /**
   * Called for each stdout chunk while the process is running.
   * Must not throw — callers should catch internally.
   * After terminal settle (timeout/cancel/close), further chunks are ignored.
   */
  onStdoutChunk?: (chunk: string) => void;
  /** Optional stderr observation — never mapped to ProgressEvent by this helper. */
  onStderrChunk?: (chunk: string) => void;
  timeoutMessage?: string;
}

/**
 * Spawn a process, stream stdout chunks, resolve with bounded captured stdout/stderr.
 */
export async function runStreamingProcess(
  input: StreamingProcessInput
): Promise<StreamingProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env
    });
    input.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdoutOverflow = false;
    let stderrOverflow = false;

    const finish = (result: StreamingProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise(result);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(
        createCodingAgentError(
          "agent_timeout",
          input.timeoutMessage ?? "Coding agent inspection timed out.",
          {
            timeoutMs: input.timeoutMs,
            phase: "inspecting"
          }
        )
      );
    }, input.timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGTERM");
      fail(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
    };

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const text = chunk.toString("utf8");
      if (!stdoutOverflow) {
        if (stdout.length + text.length > MAX_STREAM_CAPTURE_BYTES) {
          stdoutOverflow = true;
          stdout = stdout.slice(0, MAX_STREAM_CAPTURE_BYTES);
        } else {
          stdout += text;
        }
      }
      try {
        input.onStdoutChunk?.(text);
      } catch {
        // Caller must not break the process lifecycle.
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const text = chunk.toString("utf8");
      if (!stderrOverflow) {
        if (stderr.length + text.length > MAX_STREAM_CAPTURE_BYTES) {
          stderrOverflow = true;
          stderr = stderr.slice(0, MAX_STREAM_CAPTURE_BYTES);
        } else {
          stderr += text;
        }
      }
      try {
        input.onStderrChunk?.(text);
      } catch {
        // ignore
      }
    });

    child.on("error", (error) => {
      fail(createCodingAgentError("agent_unavailable", error.message));
    });

    child.on("close", (code) => {
      if (stdoutOverflow || stderrOverflow) {
        fail(
          createCodingAgentError(
            "agent_execution_failed",
            `Coding agent output exceeded ${MAX_STREAM_CAPTURE_BYTES} byte capture bound.`
          )
        );
        return;
      }
      finish({ exitCode: code, stdout, stderr });
    });
  });
}
