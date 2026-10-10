import { describe, expect, it } from "vitest";
import { processPairMeshInspectionRequest } from "./handler.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { LocalStateStore } from "../state/store.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  InspectionThreadIdSchema,
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_SECURITY_VERSION,
  PeerIdSchema,
  SessionIdSchema
} from "@pairmesh/protocol";
import { LOCAL_STATE_VERSION } from "../session/schemas.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

async function seedReceiverState(stateFile: string): Promise<string> {
  const store = new LocalStateStore({ stateFilePath: stateFile });
  const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
  await store.save({
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"),
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-19T19:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"),
        sessionId: SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"),
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-08-19T19:00:00.000Z"
      },
      agent: {
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        displayName: "kelvin-agent"
      },
      a2aAgentUrl: "http://127.0.0.1:4502",
      isLocal: true
    },
    peers: [
      {
        participant: {
          id: paulId,
          sessionId: SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"),
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-08-19T19:00:00.000Z"
        },
        agent: {
          id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          name: "paul-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          displayName: "paul-agent"
        },
        a2aAgentUrl: "http://127.0.0.1:4501",
        isLocal: false
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: [],
    permissionRequests: [],
    sessionSecurity: {
      securityVersion: PAIRMESH_SECURITY_VERSION,
      invites: [],
      acceptedInbound: [],
      capabilityGrants: []
    }
  });
  return paulId;
}

describe("receiver inspection idempotency", () => {
  it("returns cached sanitized result for duplicate requestId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-receiver-idem-"));
    const stateFile = join(dir, "kelvin.json");
    const paulId = await seedReceiverState(stateFile);

    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const store = new LocalStateStore({ stateFilePath: stateFile });
    const request = {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      sessionId: SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"),
      threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"),
      requestId: "req_idempotent",
      question: "What fields does the successful payment response contain?",
      turnNumber: 1
    };

    const first = await processPairMeshInspectionRequest(request, adapter, store, {
      participantId: paulId
    });
    const second = await processPairMeshInspectionRequest(request, adapter, store, {
      participantId: paulId
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(adapter.getInvocationCount("req_idempotent")).toBe(1);
  });
});
