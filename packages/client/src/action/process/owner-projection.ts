import type { ActionExecutionRecord, ActionParameters } from "@pairmesh/protocol";
import { formatProcessCommandDisplay } from "./artifact.js";

export interface OwnerProcessExecutionView {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  commandDisplay: string;
}

const MAX_BASENAME = 80;
const MAX_ARG = 500;
const MAX_ARGS = 50;
const MAX_CWD = 500;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Build owner-safe process details from persisted execution parameters.
 * Returns null when required approval fields are missing or malformed (fail-closed).
 */
export function projectOwnerProcessExecutionFromParameters(
  parameters: ActionParameters | Record<string, unknown> | undefined
): OwnerProcessExecutionView | null {
  if (!parameters || typeof parameters !== "object") {
    return null;
  }
  const executableRaw = parameters.executable;
  if (typeof executableRaw !== "string") {
    return null;
  }
  const executable = executableRaw.trim();
  if (
    !executable ||
    executable.length > MAX_BASENAME ||
    executable.includes("/") ||
    executable.includes("\\") ||
    executable.includes("\0")
  ) {
    return null;
  }

  if (!Array.isArray(parameters.args)) {
    return null;
  }
  if (parameters.args.length > MAX_ARGS) {
    return null;
  }
  const args: string[] = [];
  for (const entry of parameters.args) {
    if (typeof entry !== "string" || entry.length > MAX_ARG || entry.includes("\0")) {
      return null;
    }
    args.push(entry);
  }

  const cwdRaw =
    typeof parameters.cwd === "string" && parameters.cwd.trim().length > 0
      ? parameters.cwd.trim()
      : typeof parameters.cwdRelative === "string" && parameters.cwdRelative.trim().length > 0
        ? parameters.cwdRelative.trim()
        : null;
  if (!cwdRaw || cwdRaw.length > MAX_CWD || cwdRaw.includes("\0")) {
    return null;
  }
  // Receiver-safe: reject absolute paths in the approval projection.
  if (cwdRaw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwdRaw)) {
    return null;
  }

  const timeoutRaw = parameters.timeoutMs ?? parameters.timeout;
  if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw)) {
    return null;
  }
  if (timeoutRaw < MIN_TIMEOUT_MS || timeoutRaw > MAX_TIMEOUT_MS) {
    return null;
  }

  const fromParams =
    typeof parameters.commandDisplay === "string" ? parameters.commandDisplay.trim() : "";
  const commandDisplay =
    fromParams.length > 0 ? fromParams : formatProcessCommandDisplay(executable, args);
  if (!commandDisplay) {
    return null;
  }

  return {
    executable,
    args: [...args],
    cwd: cwdRaw,
    timeoutMs: timeoutRaw,
    commandDisplay
  };
}

export function projectOwnerProcessExecution(
  execution: Pick<ActionExecutionRecord, "actionType" | "parameters">
): OwnerProcessExecutionView | null {
  if (execution.actionType !== "process.execute") {
    return null;
  }
  return projectOwnerProcessExecutionFromParameters(execution.parameters);
}

export function isOwnerProcessApprovalDisplayReady(
  execution: Pick<ActionExecutionRecord, "actionType" | "parameters" | "status">
): boolean {
  if (execution.actionType !== "process.execute") {
    return true;
  }
  if (execution.status !== "approval_required") {
    return Boolean(projectOwnerProcessExecution(execution));
  }
  return projectOwnerProcessExecution(execution) !== null;
}
