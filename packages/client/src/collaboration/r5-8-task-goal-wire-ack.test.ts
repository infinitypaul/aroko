/**
 * R5-8-D2 — task.goal must acknowledge within relay ingress (~3s) while the
 * receiver provider turn continues; status hops observe later outcomes.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAIRMESH_METADATA_VERSION,
  PeerIdSchema,
  SessionIdSchema,
  type PeerId
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { CodingAgentProposalGenerator } from "../action/proposal/index.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { ActionService } from "../action/service.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "../state/store.js";
import { CollaborativeTaskService } from "./collaborative-task-service.js";
import { FakeTaskWorker } from "./fake-task-worker.js";
import { processPairMeshTaskWireRequest, TASK_WIRE_ACK_BUDGET_MS } from "./task-remote-handler.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

const RELAY_INGRESS_ABORT_MS = 3_000;

function baseState(localId: PeerId = kelvinId): LocalSessionState {
  const isKelvin = localId === kelvinId;
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R58D2X",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-09-10T01:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: localId,
        sessionId,
        developerId: isKelvin
          ? "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        agentId: isKelvin
          ? "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        joinedAt: "2026-09-10T01:00:00.000Z"
      },
      agent: {
        id: isKelvin
          ? "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        developerId: isKelvin
          ? "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        deviceId: isKelvin
          ? "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        projectId: isKelvin
          ? "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        name: isKelvin ? "kelvin-agent" : "paul-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: isKelvin
          ? "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee"
          : "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        displayName: isKelvin ? "Kelvin" : "Paul"
      },
      a2aAgentUrl: isKelvin ? "http://127.0.0.1:4502/" : "http://127.0.0.1:4501/",
      isLocal: true
    },
    peers: [
      {
        participant: {
          id: isKelvin ? paulId : kelvinId,
          sessionId,
          developerId: isKelvin
            ? "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          agentId: isKelvin
            ? "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          joinedAt: "2026-09-10T01:00:00.000Z"
        },
        agent: {
          id: isKelvin
            ? "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          developerId: isKelvin
            ? "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          deviceId: isKelvin
            ? "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          projectId: isKelvin
            ? "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          name: isKelvin ? "paul-agent" : "kelvin-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: isKelvin
            ? "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed"
            : "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          displayName: isKelvin ? "Paul" : "Kelvin"
        },
        a2aAgentUrl: isKelvin ? "http://127.0.0.1:4501/" : "http://127.0.0.1:4502/",
        isLocal: false
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: [],
    sessionSecurity: createSessionSecurity(),
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: []
  };
}

function grant(state: LocalSessionState): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
  };
  next = setGrantPolicy(next, paulId, "repository.inspect", "allow_session");
  return next;
}

async function harness(fake: FakeTaskWorker) {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r58-d2-ws-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "hello.txt"), "hello\n", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r58-d2-state-"));
  const stateFilePath = join(dir, "state.json");
  const store = new LocalStateStore({ stateFilePath });
  const actionService = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: new CodingAgentProposalGenerator(new FakeCodingAgentAdapter(workspace))
  });
  await store.save(grant(baseState(kelvinId)));
  return { store, actionService, workspace, fake };
}

describe("R5-8-D2 task.goal wire ack vs provider duration", () => {
  it("returns working ack under ingress budget while slow Fake turn continues", async () => {
    let turnStarts = 0;
    const fake = new FakeTaskWorker({
      instanceId: "slow-wire",
      onTurn: async () => {
        turnStarts += 1;
        await new Promise((r) => setTimeout(r, 5_000));
        return { kind: "completed", summary: "Slow Fake completed after ack." };
      }
    });
    const { store, actionService, workspace } = await harness(fake);

    const started = Date.now();
    const wire = await processPairMeshTaskWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        operation: "task.goal",
        originalGoal: "Prepare payment-service for package X"
      },
      {
        stateStore: store,
        participantId: paulId,
        actionService,
        workspaceRoot: workspace,
        goalProviderId: "fake",
        goalFakeWorker: fake
      }
    );
    const ackMs = Date.now() - started;

    expect(wire.accepted).toBe(true);
    if (!wire.accepted) return;
    expect(wire.status).toBe("working");
    expect(ackMs).toBeLessThan(TASK_WIRE_ACK_BUDGET_MS);
    expect(ackMs).toBeLessThan(RELAY_INGRESS_ABORT_MS);
    expect(turnStarts).toBe(1);

    let terminal: typeof wire | undefined;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const status = await processPairMeshTaskWireRequest(
        {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          sessionId,
          operation: "task.status",
          taskId: wire.taskId
        },
        { stateStore: store, participantId: paulId }
      );
      if (status.accepted && status.status === "completed") {
        terminal = status;
        break;
      }
    }

    expect(terminal?.accepted).toBe(true);
    if (!terminal?.accepted) return;
    expect(terminal.status).toBe("completed");
    expect(turnStarts).toBe(1);
  }, 20_000);

  it("fast Fake completion still returns terminal status on the goal hop", async () => {
    const fake = new FakeTaskWorker({
      instanceId: "fast-wire",
      script: [{ kind: "completed", summary: "Fast Fake completed within ack budget." }]
    });
    const { store, actionService, workspace } = await harness(fake);

    const wire = await processPairMeshTaskWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        operation: "task.goal",
        originalGoal: "Quick remote goal"
      },
      {
        stateStore: store,
        participantId: paulId,
        actionService,
        workspaceRoot: workspace,
        goalProviderId: "fake",
        goalFakeWorker: fake
      }
    );

    expect(wire.accepted).toBe(true);
    if (!wire.accepted) return;
    expect(wire.status).toBe("completed");
    const tasks = new CollaborativeTaskService(store);
    const task = await tasks.getTask(wire.taskId);
    expect(task?.status).toBe("completed");
  });
});
