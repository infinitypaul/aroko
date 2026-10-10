import { describe, expect, it } from "vitest";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { join } from "node:path";
import {
  createExecutionRecord,
  updateExecutionProgress,
  completeExecutionRecord
} from "./execution-store.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

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

describe("execution store progress", () => {
  it("emits ordered progress states", () => {
    const state = emptyState();
    const record = createExecutionRecord({
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      peerId: "peer_kelvin",
      peerName: "kelvin-agent",
      turnNumber: 1,
      question: "Why can customerId be null?"
    });

    state.inspectionExecutions.push(record);
    updateExecutionProgress(state, record.requestId, {
      phase: "peer-reachable",
      message: "Peer reachable."
    });
    updateExecutionProgress(state, record.requestId, {
      phase: "inspecting",
      message: "Inspecting..."
    });
    completeExecutionRecord(state, record.requestId, "completed");

    const phases = state.inspectionExecutions[0]?.phase;
    expect(phases).toBe("completed");
    expect(state.inspectionExecutions[0]?.status).toBe("completed");
  });
});

describe("FakeCodingAgentAdapter progress", () => {
  it("reports starting, inspecting, and completed phases", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace, 10);
    const phases: string[] = [];

    await adapter.inspect(
      { requestId: "req_progress", question: "What fields does the payment response contain?" },
      {
        onProgress: (event) => {
          phases.push(event.phase);
        }
      }
    );

    expect(phases).toContain("coding-agent-starting");
    expect(phases).toContain("inspecting");
    expect(phases).toContain("completed");
  });
});

describe("FakeCodingAgentAdapter busy state", () => {
  it("reports busy while an inspection is running", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace, 50);
    const first = adapter.inspect({
      requestId: "req_busy_1",
      question: "What fields does the payment response contain?"
    });
    const availability = await adapter.getAvailability();
    expect(availability.status).toBe("busy");
    await first;
    const after = await adapter.getAvailability();
    expect(after.status).toBe("available");
  });
});
