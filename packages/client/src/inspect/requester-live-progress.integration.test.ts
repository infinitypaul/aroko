import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import {
  InspectionThreadIdSchema,
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_SECURITY_VERSION,
  PeerIdSchema,
  SessionIdSchema,
  projectInspectionProgressForRequester,
  type ProgressEvent
} from "@pairmesh/protocol";
import { encodePairMeshInspectProgress } from "../a2a/inspection-messages.js";
import { extractInspectProgressFromTask } from "../a2a/task-lifecycle.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { LocalStateStore } from "../state/store.js";
import { LOCAL_STATE_VERSION } from "../session/schemas.js";
import { processPairMeshInspectionRequest } from "./handler.js";
import { mergeRequesterInspectProgress } from "./requester-progress.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
const THOUGHT = "PRIVATE_COT_MUST_NEVER_CROSS_A2A";

async function seedReceiverState(stateFile: string): Promise<void> {
  const store = new LocalStateStore({ stateFilePath: stateFile });
  await store.save({
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-WATCH2",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-09-01T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: kelvinId,
        sessionId,
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-09-01T12:00:00.000Z"
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
        displayName: "Kelvin"
      },
      a2aAgentUrl: "http://127.0.0.1:4502",
      isLocal: true,
      serviceLabel: "payment-service"
    },
    peers: [
      {
        participant: {
          id: paulId,
          sessionId,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-09-01T12:00:00.000Z"
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
          displayName: "Paul"
        },
        a2aAgentUrl: "http://127.0.0.1:4501",
        isLocal: false
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: [],
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: [],
    sessionSecurity: {
      securityVersion: PAIRMESH_SECURITY_VERSION,
      invites: [],
      acceptedInbound: [],
      capabilityGrants: []
    }
  });
}

describe("Stage 19 Prompt 6 — isolated two-peer Fake progress path", () => {
  it("requester sees safe progress before remote end without owner paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-p6-iso-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);
    const store = new LocalStateStore({ stateFilePath: stateFile });
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace, 100);

    let remoteEnded = false;
    let requesterRichBeforeRemoteEnd = false;
    let requesterTape: ProgressEvent[] = [];
    const wireBodies: string[] = [];

    const pending = processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af06"),
        requestId: "req_p6_iso",
        question: "Where is ProgressEvent requester visibility filtered?",
        turnNumber: 1
      },
      adapter,
      store,
      {
        participantId: paulId,
        onProgressPersisted: (ownerEvents) => {
          const projected = projectInspectionProgressForRequester(ownerEvents);
          const message = encodePairMeshInspectProgress({
            metadataVersion: PAIRMESH_METADATA_VERSION,
            requestId: "req_p6_iso",
            latestSequence: Math.max(0, ...projected.map((e) => e.sequence ?? 0)),
            events: projected
          });
          wireBodies.push(JSON.stringify(message));
          const task: Task = {
            id: "task_p6",
            contextId: "ctx",
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: {
                ...message,
                role: Role.ROLE_AGENT,
                contextId: "ctx",
                taskId: "task_p6"
              },
              timestamp: new Date().toISOString()
            },
            history: [],
            artifacts: [],
            metadata: undefined
          };
          const extracted = extractInspectProgressFromTask(task);
          requesterTape = mergeRequesterInspectProgress(requesterTape, extracted?.events);
          if (
            !remoteEnded &&
            requesterTape.length > 0 &&
            (requesterTape.some((e) => e.activityKind === "worker.started") ||
              requesterTape.some((e) => e.phase === "provider_started")) &&
            requesterTape.some(
              (e) =>
                e.activityKind === "provider.message" ||
                e.message === "Inspecting relevant code." ||
                e.message === "Searching repository." ||
                (typeof e.message === "string" && e.message.length > 5)
            )
          ) {
            requesterRichBeforeRemoteEnd = true;
          }
        }
      }
    );

    const response = await pending;
    remoteEnded = true;
    expect(response.accepted).toBe(true);
    expect(requesterRichBeforeRemoteEnd).toBe(true);
    expect(wireBodies.length).toBeGreaterThan(0);

    const allWire = wireBodies.join("\n");
    expect(allWire).not.toContain(THOUGHT);
    expect(allWire).not.toMatch(/\/Users\//);
    expect(JSON.stringify(requesterTape)).not.toContain("src/retry.ts");
    expect(requesterTape.every((e) => e.visibility === "requester_safe")).toBe(true);

    const owner = (await store.load())!.inspectionExecutions.find(
      (e) => e.requestId === "req_p6_iso"
    );
    const ownerHasPath = JSON.stringify(owner?.progressEvents ?? []).includes("src/");
    // Owner may see paths; requester must not.
    expect(ownerHasPath || (owner?.progressEvents?.length ?? 0) > 0).toBe(true);
  });
});
