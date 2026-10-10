import { mkdir, readFile, stat, truncate } from "node:fs/promises";
import { closeSync, createReadStream, openSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  runtimeErrorLogFilePath,
  runtimeLogFilePath,
  runtimeLogsDir
} from "../local-config/paths.js";

const MAX_LOG_BYTES = 512 * 1024;

export async function ensureRuntimeLogFiles(workspace: string): Promise<{
  logFile: string;
  errorLogFile: string;
}> {
  const dir = runtimeLogsDir(workspace);
  await mkdir(dir, { recursive: true });
  const logFile = runtimeLogFilePath(workspace);
  const errorLogFile = runtimeErrorLogFilePath(workspace);
  await rotateLogIfNeeded(logFile);
  await rotateLogIfNeeded(errorLogFile);
  return { logFile, errorLogFile };
}

async function rotateLogIfNeeded(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size > MAX_LOG_BYTES) {
      await truncate(path, 0);
    }
  } catch {
    // file may not exist yet
  }
}

export async function readRecentLogLines(
  workspace: string,
  lineCount = 50
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout = await tailFile(runtimeLogFilePath(workspace), lineCount);
  const stderr = await tailFile(runtimeErrorLogFilePath(workspace), lineCount);
  return { stdout, stderr };
}

async function tailFile(path: string, lineCount: number): Promise<string[]> {
  try {
    const content = await readFile(path, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    return lines.slice(-lineCount);
  } catch {
    return [];
  }
}

export async function followRuntimeLog(
  workspace: string,
  stream: "stdout" | "stderr" | "both" = "stdout"
): Promise<void> {
  const paths =
    stream === "both"
      ? [runtimeLogFilePath(workspace), runtimeErrorLogFilePath(workspace)]
      : stream === "stderr"
        ? [runtimeErrorLogFilePath(workspace)]
        : [runtimeLogFilePath(workspace)];

  await Promise.all(
    paths.map(async (path) => {
      try {
        const input = createReadStream(path, { encoding: "utf8" });
        const rl = createInterface({ input, crlfDelay: Infinity });
        for await (const line of rl) {
          console.log(line);
        }
      } catch {
        // ignore missing logs
      }
    })
  );
}

export async function openRuntimeLogHandles(workspace: string): Promise<{
  stdoutFd: number;
  stderrFd: number;
  logFile: string;
  errorLogFile: string;
  close: () => void;
}> {
  const { logFile, errorLogFile } = await ensureRuntimeLogFiles(workspace);
  const stdoutFd = openSync(logFile, "a");
  const stderrFd = openSync(errorLogFile, "a");
  return {
    stdoutFd,
    stderrFd,
    logFile,
    errorLogFile,
    close: () => {
      try {
        closeSync(stdoutFd);
      } catch {
        // ignore
      }
      try {
        closeSync(stderrFd);
      } catch {
        // ignore
      }
    }
  };
}
