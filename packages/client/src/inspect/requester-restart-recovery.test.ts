/**
 * Stage 19 post-freeze remediation — requester runtime restart while receiver continues.
 *
 * Models the real incident:
 * - Paul starts inspection (requestId X)
 * - Kelvin executes; Paul restarts → stale peerAgentUrl egress
 * - Kelvin reaches COMPLETED
 * - Paul waitForInspection(X) must re-resolve live peer URL and return COMPLETED
 * - No second SendMessage / new requestId
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import {
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  type PairMeshInspectionResponse
} from "@pairmesh/protocol";
import { generateBearerToken } from "../auth/secrets.js";
import {
  attachA2ATaskReference,
  completeExecutionRecord,
  createExecutionRecord,
  findExecutionRecord,
  upsertExecutionRecord
} from "./execution-store.js";
import { createInitiatorThreadRecord } from "./thread-store.js";
import { resolveCurrentPeerPollUrl, syncExecutionFromRemoteTask } from "./remote-sync.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "../state/store.js";

const KELVIN_ID = "peer_8654a3c5-7f6f-4438-8790-95ba7655b224";
const TASK_ID = "task_remote_01";
const STALE_EGRESS = "http://127.0.0.1:58965";
const LIVE_EGRESS = "http://127.0.0.1:59100";

const getTaskMock = vi.fn();

vi.mock("../a2a/inspection-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../a2a/inspection-client.js")>();
  return {
    ...actual,
    getPairMeshInspectionTask: (...args: unknown[]) => getTaskMock(...args),
    cancelPairMeshInspectionTask: vi.fn(async () => ({})),
    resendInspectionForCachedResult: vi.fn(async () => undefined)
  };
});

function emptyState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-09-01T07:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-09-01T07:00:00.000Z"
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
    peers: [
      {
        participant: {
          id: KELVIN_ID,
          sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_8654a3c5-7f6f-4438-8790-95ba7655b224",
          agentId: "agt_8654a3c5-7f6f-4438-8790-95ba7655b224",
          joinedAt: "2026-09-01T07:00:00.000Z"
        },
        agent: {
          id: "agt_8654a3c5-7f6f-4438-8790-95ba7655b224",
          developerId: "dev_8654a3c5-7f6f-4438-8790-95ba7655b224",
          deviceId: "devc_8654a3c5-7f6f-4438-8790-95ba7655b224",
          projectId: "prj_8654a3c5-7f6f-4438-8790-95ba7655b224",
          name: "payment-service-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: "dev_8654a3c5-7f6f-4438-8790-95ba7655b224",
          displayName: "kelvin"
        },
        a2aAgentUrl: LIVE_EGRESS,
        isLocal: false,
        outboundBearer: generateBearerToken()
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: []
  };
}

function seedRunningInspection(state: LocalSessionState): string {
  const thread = createInitiatorThreadRecord({
    state,
    targetPeerName: "payment-service-agent",
    targetPeerId: KELVIN_ID,
    topic: "Explain customerId normalization"
  });
  state.inspectionThreads.push(thread);
  const record = createExecutionRecord({
    threadId: thread.thread.id,
    peerId: KELVIN_ID,
    peerName: "payment-service-agent",
    turnNumber: 1,
    question: "Explain customerId normalization"
  });
  upsertExecutionRecord(state, record);
  attachA2ATaskReference(state, record.requestId, TASK_ID, STALE_EGRESS, "working");
  const attached = findExecutionRecord(state, record.requestId)!;
  attached.peerAgentUrl = STALE_EGRESS;
  if (attached.a2aTaskReference) {
    attached.a2aTaskReference.agent = { a2aAgentCardUrl: STALE_EGRESS };
  }
  return record.requestId;
}

function completedTaskPayload(requestId: string): {
  task: Task;
  response: PairMeshInspectionResponse;
} {
  const response: PairMeshInspectionResponse = {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    requestId,
    accepted: true,
    summary: "customerId normalization is ?? null only.",
    findings: ["rebuildPaymentFromRetryRecord inlines ?? null"],
    references: [{ file: "src/retry.ts", symbol: "rebuildPaymentFromRetryRecord" }]
  };
  const task = {
    id: TASK_ID,
    contextId: "ctx",
    status: { state: TaskState.Completed },
    artifacts: [
      {
        artifactId: "art",
        parts: [
          {
            kind: "data",
            data: response,
            metadata: { mimeType: PAIRMESH_PAYLOAD_MEDIA_TYPE }
          }
        ]
      }
    ]
  } as unknown as Task;
  return { task, response };
}

afterEach(() => {
  getTaskMock.mockReset();
});

describe("Stage 19 — requester restart recovery (Issue A)", () => {
  it("resolveCurrentPeerPollUrl prefers live peer URL over stale execution snapshot", () => {
    const state = emptyState();
    const requestId = seedRunningInspection(state);
    const record = findExecutionRecord(state, requestId)!;
    expect(record.peerAgentUrl).toBe(STALE_EGRESS);
    expect(resolveCurrentPeerPollUrl(state, record)).toBe(LIVE_EGRESS);
  });

  it("after remint, sync retrieves remote COMPLETED via live egress — same requestId, one GetTask", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-restart-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const state = emptyState();
    const requestId = seedRunningInspection(state);
    await store.save(state);

    const { task, response } = completedTaskPayload(requestId);
    getTaskMock.mockImplementation(async (url: string, taskId: string) => {
      expect(url).toBe(LIVE_EGRESS);
      expect(taskId).toBe(TASK_ID);
      return { task, remoteTaskState: "completed", response };
    });

    const outcome = await syncExecutionFromRemoteTask(requestId, store, {
      maxDurationMs: 120_000,
      attemptCancelOnHardTimeout: false
    });

    expect(outcome.record.status).toBe("completed");
    expect(outcome.record.requestId).toBe(requestId);
    expect(outcome.record.result?.summary).toContain("customerId");
    expect(outcome.hardTimedOut).toBe(false);
    expect(getTaskMock).toHaveBeenCalledTimes(1);
    expect(getTaskMock.mock.calls[0]![0]).toBe(LIVE_EGRESS);

    const after = await store.load();
    const saved = findExecutionRecord(after!, requestId)!;
    expect(saved.peerAgentUrl).toBe(LIVE_EGRESS);
    expect(saved.status).toBe("completed");
  });

  it("does not fabricate timed_out when GetTask hits transport failure past deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-restart-to-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const state = emptyState();
    const requestId = seedRunningInspection(state);
    const record = findExecutionRecord(state, requestId)!;
    const threeMinutesAgo = new Date(Date.now() - 180_000).toISOString();
    record.startedAt = threeMinutesAgo;
    record.executionStartedAt = threeMinutesAgo;
    await store.save(state);

    getTaskMock.mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:58965"), {
          code: "ECONNREFUSED"
        })
      })
    );

    await expect(
      syncExecutionFromRemoteTask(requestId, store, {
        maxDurationMs: 120_000,
        attemptCancelOnHardTimeout: false
      })
    ).rejects.toBeTruthy();

    const after = await store.load();
    const saved = findExecutionRecord(after!, requestId)!;
    expect(saved.status).toBe("running");
    expect(saved.status).not.toBe("timed_out");
  });

  it("recovers fabricated local timed_out when remote already COMPLETED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-restart-fab-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const state = emptyState();
    const requestId = seedRunningInspection(state);
    completeExecutionRecord(state, requestId, "timed_out", {
      code: "pairmesh.inspection_timeout",
      message: "Remote inspection exceeded the configured execution deadline."
    });
    await store.save(state);

    const { task, response } = completedTaskPayload(requestId);
    getTaskMock.mockResolvedValue({
      task,
      remoteTaskState: "completed",
      response
    });

    const outcome = await syncExecutionFromRemoteTask(requestId, store, {
      maxDurationMs: 120_000,
      attemptCancelOnHardTimeout: false
    });

    expect(outcome.record.status).toBe("completed");
    expect(outcome.record.requestId).toBe(requestId);
    expect(outcome.record.result?.summary).toContain("customerId");
    expect(getTaskMock).toHaveBeenCalledTimes(1);
    expect(getTaskMock.mock.calls[0]![0]).toBe(LIVE_EGRESS);
  });
});
