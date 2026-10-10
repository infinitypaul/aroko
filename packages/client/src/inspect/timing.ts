export interface InspectionTimingConfig {
  /** MCP ask_peer quick-ack grace period (ms). Must stay well below Cursor MCP timeout. */
  interactiveWaitMs: number;
  /** Default pairmesh_wait_for_inspection wait (ms). Clamped to mcpMaxWaitMs. */
  mcpWaitForInspectionMs: number;
  /** Upper bound for any MCP blocking wait tool call (ms). */
  mcpMaxWaitMs: number;
  /** Short window to return an existing active handle for the same question (ms). */
  duplicateQuestionWindowMs: number;
  /** Poll interval while waiting for remote A2A task progress (ms). */
  pollIntervalMs: number;
  /** Hard remote ACP/A2A execution deadline (ms). Does not include human approval wait. */
  maxDurationMs: number;
}

/** Quick-ack default: return working handle before Cursor MCP timeout. */
export const DEFAULT_INSPECTION_INTERACTIVE_WAIT_MS = 750;

/** Default MCP wait tool duration — fits comfortably inside measured Cursor timeout. */
export const DEFAULT_MCP_WAIT_FOR_INSPECTION_MS = 4_000;

/** Maximum wait any MCP tool may block (clamp user-supplied waitMs). */
export const DEFAULT_MCP_MAX_WAIT_MS = 8_000;

/** Return existing active handle when the same question is re-asked within this window. */
export const DEFAULT_DUPLICATE_QUESTION_WINDOW_MS = 45_000;

export const DEFAULT_INSPECTION_POLL_INTERVAL_MS = 500;

export const DEFAULT_INSPECTION_MAX_DURATION_MS = 120_000;

export function loadInspectionTimingFromEnv(): InspectionTimingConfig {
  return {
    interactiveWaitMs: readPositiveIntEnv(
      "PAIRMESH_INSPECTION_INTERACTIVE_WAIT_MS",
      DEFAULT_INSPECTION_INTERACTIVE_WAIT_MS
    ),
    mcpWaitForInspectionMs: readPositiveIntEnv(
      "PAIRMESH_INSPECTION_MCP_WAIT_MS",
      DEFAULT_MCP_WAIT_FOR_INSPECTION_MS
    ),
    mcpMaxWaitMs: readPositiveIntEnv(
      "PAIRMESH_INSPECTION_MCP_MAX_WAIT_MS",
      DEFAULT_MCP_MAX_WAIT_MS
    ),
    duplicateQuestionWindowMs: readPositiveIntEnv(
      "PAIRMESH_INSPECTION_DUPLICATE_WINDOW_MS",
      DEFAULT_DUPLICATE_QUESTION_WINDOW_MS
    ),
    pollIntervalMs: readPositiveIntEnv(
      "PAIRMESH_INSPECTION_POLL_INTERVAL_MS",
      DEFAULT_INSPECTION_POLL_INTERVAL_MS
    ),
    maxDurationMs: readPositiveIntEnv(
      "PAIRMESH_INSPECTION_MAX_DURATION_MS",
      DEFAULT_INSPECTION_MAX_DURATION_MS
    )
  };
}

export function clampMcpWaitMs(
  requestedMs: number | undefined,
  timing: Pick<InspectionTimingConfig, "mcpWaitForInspectionMs" | "mcpMaxWaitMs">
): number {
  const fallback = timing.mcpWaitForInspectionMs;
  const raw = requestedMs ?? fallback;
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(raw), timing.mcpMaxWaitMs);
}

export function clampInspectionWaitMs(
  requestedMs: number | undefined,
  timing: Pick<InspectionTimingConfig, "mcpWaitForInspectionMs" | "mcpMaxWaitMs" | "maxDurationMs">,
  options?: { clampToMcpMax?: boolean }
): number {
  if (options?.clampToMcpMax !== false) {
    return clampMcpWaitMs(requestedMs, timing);
  }
  const fallback = Math.min(60_000, timing.maxDurationMs);
  const raw = requestedMs ?? fallback;
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(raw), timing.maxDurationMs);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
