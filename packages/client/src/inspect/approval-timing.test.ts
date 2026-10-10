import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachA2ATaskReference,
  createExecutionRecord,
  findExecutionRecord,
  findResumableApprovalRequiredExecution,
  inspectionExecutionDeadlineStartMs,
  upsertExecutionRecord
} from "./execution-store.js";
import { syncExecutionFromRemoteTask } from "./remote-sync.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "../state/store.js";

function emptyState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-19T19:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-08-19T19:00:00.000Z"
      },
      agent: {
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        name: "paul-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        displayName: "paul-agent"
      },
      a2aAgentUrl: "http://127.0.0.1:4501",
      isLocal: true
    },
    peers: [],
    inspectionThreads: [],
    inspectionExecutions: []
  };
}

describe("approval resume vs duplicate window", () => {
  it("resumes approval_required after more than 45s using permission TTL", () => {
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "Where is rebuildPaymentFromRetryRecord defined?"
    });
    const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();
    record.startedAt = sixtySecondsAgo;
    record.updatedAt = sixtySecondsAgo;
    record.status = "failed";
    record.error = {
      code: "pairmesh.approval_required",
      message: "Needs approval"
    };
    upsertExecutionRecord(state, record);

    const resumed = findResumableApprovalRequiredExecution(state, {
      peerId: "peer_kelvin",
      question: record.question,
      windowMs: 45_000
    });

    expect(resumed?.requestId).toBe(record.requestId);
  });

  it("does not resume approval_required past the permission TTL safety bound", () => {
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "Where is rebuildPaymentFromRetryRecord defined?"
    });
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000).toISOString();
    record.startedAt = elevenMinutesAgo;
    record.updatedAt = elevenMinutesAgo;
    record.status = "failed";
    record.error = {
      code: "pairmesh.approval_required",
      message: "Needs approval"
    };
    upsertExecutionRecord(state, record);

    const resumed = findResumableApprovalRequiredExecution(state, {
      peerId: "peer_kelvin",
      question: record.question
    });

    expect(resumed).toBeUndefined();
  });
});

describe("inspection execution deadline clock", () => {
  it("ignores startedAt until remote execution has begun", () => {
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "q"
    });
    record.startedAt = "2020-01-01T00:00:00.000Z";
    expect(inspectionExecutionDeadlineStartMs(record)).toBeUndefined();
  });

  it("starts the deadline clock when an A2A task is attached", () => {
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "q"
    });
    record.startedAt = "2020-01-01T00:00:00.000Z";
    upsertExecutionRecord(state, record);

    const attached = attachA2ATaskReference(
      state,
      record.requestId,
      "task_1",
      "http://127.0.0.1:4700/"
    );
    expect(attached?.executionStartedAt).toBeTruthy();
    expect(inspectionExecutionDeadlineStartMs(attached!)).toBe(
      Date.parse(attached!.executionStartedAt!)
    );
  });

  it("does not hard-timeout while awaiting permission (no executionStartedAt)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-deadline-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "q"
    });
    record.status = "pending";
    record.startedAt = new Date(Date.now() - 200_000).toISOString();
    record.updatedAt = record.startedAt;
    upsertExecutionRecord(state, record);
    await store.save(state);

    const outcome = await syncExecutionFromRemoteTask(record.requestId, store, {
      maxDurationMs: 120_000,
      attemptCancelOnHardTimeout: false
    });

    expect(outcome.hardTimedOut).toBe(false);
    expect(outcome.record.status).toBe("pending");
  });

  it("hard-timeouts from executionStartedAt, not an old startedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-deadline-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "q"
    });
    record.status = "running";
    record.startedAt = new Date(Date.now() - 200_000).toISOString();
    record.executionStartedAt = new Date(Date.now() - 1_000).toISOString();
    record.updatedAt = record.executionStartedAt;
    upsertExecutionRecord(state, record);
    await store.save(state);

    const withinBudget = await syncExecutionFromRemoteTask(record.requestId, store, {
      maxDurationMs: 120_000,
      attemptCancelOnHardTimeout: false
    });
    expect(withinBudget.hardTimedOut).toBe(false);
    expect(withinBudget.record.status).toBe("running");

    const timed = findExecutionRecord(state, record.requestId)!;
    timed.executionStartedAt = new Date(Date.now() - 130_000).toISOString();
    upsertExecutionRecord(state, timed);
    await store.save(state);

    const overBudget = await syncExecutionFromRemoteTask(record.requestId, store, {
      maxDurationMs: 120_000,
      attemptCancelOnHardTimeout: false
    });
    expect(overBudget.hardTimedOut).toBe(true);
    expect(overBudget.record.status).toBe("timed_out");
  });
});
