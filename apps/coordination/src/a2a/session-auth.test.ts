import {
  LocalStateStore,
  SessionManager,
  buildInspectionRequest,
  cancelPairMeshInspectionTask,
  createInvite,
  generateBearerToken,
  getPairMeshInspectionTask,
  issueInboundCredential,
  runPairMeshInspectionInteractive
} from "@pairmesh/client";
import { InspectionThreadIdSchema } from "@pairmesh/protocol";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "./index.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

function pickPort(): number {
  return 48_000 + Math.floor(Math.random() * 1_500);
}

async function waitUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function threadId(): string {
  return InspectionThreadIdSchema.parse(`thr_${randomUUID()}`);
}

/**
 * Stands up a receiver agent whose session already has one paired peer, and
 * returns the plaintext bearer that peer must present.
 */
async function createReceiver(): Promise<{
  agent: ReturnType<typeof createPairMeshA2AAgent>;
  store: LocalStateStore;
  sessionId: string;
  peerBearer: string;
  peerParticipantId: string;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-auth-"));
  const statePath = join(dir, "state.json");
  const previousStateFile = process.env.PAIRMESH_STATE_FILE;
  process.env.PAIRMESH_STATE_FILE = statePath;

  const store = new LocalStateStore({ stateFilePath: statePath });
  const manager = new SessionManager({ stateStore: store });
  const agentPort = pickPort();
  const agent = createPairMeshA2AAgent({
    name: "kelvin-agent",
    host: "127.0.0.1",
    port: agentPort
  });
  await waitUntilReachable(`${agent.baseUrl}/health`);

  await manager.createSession({ name: "kelvin-agent", agentUrl: agent.baseUrl });
  const state = await store.load();
  if (!state?.sessionSecurity) {
    throw new Error("expected an authenticated session");
  }

  const peerRecord = {
    ...state.localParticipant,
    isLocal: false,
    a2aAgentUrl: "http://127.0.0.1:4999",
    outboundBearer: generateBearerToken()
  };
  const issued = issueInboundCredential(peerRecord.participant.id);
  await store.save({
    ...state,
    peers: [peerRecord],
    sessionSecurity: {
      ...state.sessionSecurity,
      acceptedInbound: [issued.credential]
    }
  });

  return {
    agent,
    store,
    sessionId: state.session.id,
    peerBearer: issued.token,
    peerParticipantId: peerRecord.participant.id,
    close: async () => {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await agent.close();
    }
  };
}

describe("bearer-authenticated inspection", () => {
  let previousProvider: string | undefined;
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
  });

  afterEach(() => {
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
    process.env.PAIRMESH_WORKSPACE = previousWorkspace;
  });

  it("rejects inspection without a bearer token", async () => {
    const receiver = await createReceiver();
    try {
      await expect(
        runPairMeshInspectionInteractive(
          receiver.agent.baseUrl,
          buildInspectionRequest(receiver.sessionId, threadId(), "Where is payment handled?", 1),
          { timeoutMs: 8_000, pollIntervalMs: 100 }
        )
      ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    } finally {
      await receiver.close();
    }
  }, 25_000);

  it("rejects inspection with an unknown bearer token", async () => {
    const receiver = await createReceiver();
    try {
      await expect(
        runPairMeshInspectionInteractive(
          receiver.agent.baseUrl,
          buildInspectionRequest(receiver.sessionId, threadId(), "Where is payment handled?", 1),
          { timeoutMs: 8_000, pollIntervalMs: 100, bearerToken: generateBearerToken() }
        )
      ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    } finally {
      await receiver.close();
    }
  }, 25_000);

  it("accepts inspection from a paired peer presenting its bearer", async () => {
    const receiver = await createReceiver();
    try {
      const result = await runPairMeshInspectionInteractive(
        receiver.agent.baseUrl,
        buildInspectionRequest(receiver.sessionId, threadId(), "Where is payment handled?", 1),
        { timeoutMs: 15_000, pollIntervalMs: 100, bearerToken: receiver.peerBearer }
      );

      expect(result.response?.accepted).toBe(true);
    } finally {
      await receiver.close();
    }
  }, 30_000);

  it("rejects inspection for a different session id", async () => {
    const receiver = await createReceiver();
    try {
      const result = await runPairMeshInspectionInteractive(
        receiver.agent.baseUrl,
        buildInspectionRequest(`ses_${randomUUID()}`, threadId(), "Where is payment handled?", 1),
        { timeoutMs: 10_000, pollIntervalMs: 100, bearerToken: receiver.peerBearer }
      );

      expect(result.response?.accepted).toBe(false);
      if (result.response && !result.response.accepted) {
        expect(result.response.error.code).not.toBe("pairmesh.internal_error");
      }
    } finally {
      await receiver.close();
    }
  }, 25_000);

  it("stops accepting a revoked peer's bearer after removal", async () => {
    const receiver = await createReceiver();
    try {
      const manager = new SessionManager({ stateStore: receiver.store });
      await manager.removePeer("kelvin-agent");

      // The removed peer still holds its bearer, but the credential no longer
      // resolves to a session member.
      await expect(
        runPairMeshInspectionInteractive(
          receiver.agent.baseUrl,
          buildInspectionRequest(receiver.sessionId, threadId(), "Where is payment handled?", 1),
          { timeoutMs: 10_000, pollIntervalMs: 100, bearerToken: receiver.peerBearer }
        )
      ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    } finally {
      await receiver.close();
    }
  }, 25_000);
});

describe("task-scoped authorization", () => {
  let previousProvider: string | undefined;
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
  });

  afterEach(() => {
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
    process.env.PAIRMESH_WORKSPACE = previousWorkspace;
  });

  it("allows the task owner to read the task and refuses everyone else", async () => {
    const receiver = await createReceiver();
    try {
      const started = await runPairMeshInspectionInteractive(
        receiver.agent.baseUrl,
        buildInspectionRequest(receiver.sessionId, threadId(), "Where is payment handled?", 1),
        { timeoutMs: 15_000, pollIntervalMs: 100, bearerToken: receiver.peerBearer }
      );
      const taskId = started.a2aTaskId;
      expect(taskId).toBeTruthy();

      const owned = await getPairMeshInspectionTask(receiver.agent.baseUrl, taskId, {
        bearerToken: receiver.peerBearer
      });
      expect(owned.task?.id).toBe(taskId);

      // Unauthenticated task reads are refused outright.
      await expect(getPairMeshInspectionTask(receiver.agent.baseUrl, taskId)).rejects.toMatchObject(
        { code: "pairmesh.authentication_required" }
      );

      // A second paired participant may authenticate but cannot touch a task it
      // does not own.
      const state = await receiver.store.load();
      if (!state?.sessionSecurity) {
        throw new Error("expected session security");
      }
      const otherPeer = {
        ...state.localParticipant,
        participant: {
          ...state.localParticipant.participant,
          id: `peer_${randomUUID()}`
        },
        isLocal: false,
        a2aAgentUrl: "http://127.0.0.1:4998"
      };
      const otherCredential = issueInboundCredential(otherPeer.participant.id);
      await receiver.store.save({
        ...state,
        peers: [...state.peers, otherPeer],
        sessionSecurity: {
          ...state.sessionSecurity,
          acceptedInbound: [...state.sessionSecurity.acceptedInbound, otherCredential.credential]
        }
      });

      await expect(
        getPairMeshInspectionTask(receiver.agent.baseUrl, taskId, {
          bearerToken: otherCredential.token
        })
      ).rejects.toMatchObject({ code: "pairmesh.authentication_failed" });

      await expect(
        cancelPairMeshInspectionTask(receiver.agent.baseUrl, taskId, otherCredential.token)
      ).rejects.toBeDefined();
    } finally {
      await receiver.close();
    }
  }, 35_000);

  it("refuses invite secrets as bearer credentials", async () => {
    const receiver = await createReceiver();
    try {
      const invite = createInvite();
      await expect(
        runPairMeshInspectionInteractive(
          receiver.agent.baseUrl,
          buildInspectionRequest(receiver.sessionId, threadId(), "Where is payment handled?", 1),
          { timeoutMs: 10_000, pollIntervalMs: 100, bearerToken: invite.secret }
        )
      ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    } finally {
      await receiver.close();
    }
  }, 25_000);
});
