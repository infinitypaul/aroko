import { describe, expect, it } from "vitest";
import {
  createExecutionRecord,
  findRecentDuplicateExecution,
  normalizeInspectionQuestion,
  upsertExecutionRecord
} from "./execution-store.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import {
  clampInspectionWaitMs,
  clampMcpWaitMs,
  DEFAULT_INSPECTION_INTERACTIVE_WAIT_MS,
  DEFAULT_INSPECTION_MAX_DURATION_MS,
  DEFAULT_MCP_MAX_WAIT_MS,
  DEFAULT_MCP_WAIT_FOR_INSPECTION_MS,
  loadInspectionTimingFromEnv
} from "./timing.js";

function emptyState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: "ses_test",
      createdBy: "dev_test",
      createdAt: "2026-08-19T19:00:00.000Z",
      status: "active"
    },
    localParticipant: {} as LocalSessionState["localParticipant"],
    peers: [],
    inspectionThreads: [],
    inspectionExecutions: []
  };
}

describe("normalizeInspectionQuestion", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeInspectionQuestion("  Which   Function?  ")).toBe("which function?");
  });
});

describe("findRecentDuplicateExecution", () => {
  it("returns a recent active execution for the same peer and question", () => {
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "Which function rebuilds payment?"
    });
    record.status = "running";
    upsertExecutionRecord(state, record);

    const duplicate = findRecentDuplicateExecution(state, {
      peerId: "peer_kelvin",
      question: "  which function rebuilds payment? ",
      windowMs: 60_000
    });

    expect(duplicate?.requestId).toBe(record.requestId);
  });

  it("ignores executions outside the duplicate window", () => {
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "Which function rebuilds payment?"
    });
    record.status = "running";
    record.startedAt = "2020-01-01T00:00:00.000Z";
    record.updatedAt = record.startedAt;
    upsertExecutionRecord(state, record);

    const duplicate = findRecentDuplicateExecution(state, {
      peerId: "peer_kelvin",
      question: record.question,
      windowMs: 60_000
    });

    expect(duplicate).toBeUndefined();
  });
});

describe("inspection timing defaults", () => {
  it("uses quick-ack interactive wait and bounded MCP wait defaults", () => {
    delete process.env.PAIRMESH_INSPECTION_INTERACTIVE_WAIT_MS;
    delete process.env.PAIRMESH_INSPECTION_MCP_WAIT_MS;
    delete process.env.PAIRMESH_INSPECTION_MCP_MAX_WAIT_MS;

    const timing = loadInspectionTimingFromEnv();
    expect(timing.interactiveWaitMs).toBe(DEFAULT_INSPECTION_INTERACTIVE_WAIT_MS);
    expect(timing.mcpWaitForInspectionMs).toBe(DEFAULT_MCP_WAIT_FOR_INSPECTION_MS);
    expect(clampMcpWaitMs(120_000, timing)).toBe(DEFAULT_MCP_MAX_WAIT_MS);
    expect(clampInspectionWaitMs(60_000, timing, { clampToMcpMax: false })).toBe(60_000);
    expect(clampInspectionWaitMs(999_999, timing, { clampToMcpMax: false })).toBe(
      DEFAULT_INSPECTION_MAX_DURATION_MS
    );
  });
});
