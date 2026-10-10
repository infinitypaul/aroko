import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalStateStore,
  SessionManager,
  buildJoinRequest,
  createLocalPairMeshIdentity,
  generateBearerToken,
  generateInviteSecret,
  sendPairMeshJoinRequest
} from "@pairmesh/client";
import { describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "../a2a/index.js";

async function waitUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function tempStatePair(): Promise<{
  creatorStore: LocalStateStore;
  joinerStore: LocalStateStore;
  creatorPath: string;
  joinerPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-pair-"));
  const creatorPath = join(dir, "creator.json");
  const joinerPath = join(dir, "joiner.json");
  return {
    creatorPath,
    joinerPath,
    creatorStore: new LocalStateStore({ stateFilePath: creatorPath }),
    joinerStore: new LocalStateStore({ stateFilePath: joinerPath })
  };
}

describe("PairMesh pairing handshake", () => {
  it("shares canonical SessionId and registers both participants automatically", async () => {
    const { creatorStore, joinerStore, creatorPath, joinerPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4411
    });
    // Each agent binds the state file current at creation time.
    process.env.PAIRMESH_STATE_FILE = joinerPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4412
    });
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({ stateStore: creatorStore });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      const kelvin = new SessionManager({ stateStore: joinerStore });
      const joined = await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      expect(joined.sessionId).toBe(created.sessionId);
      expect(joined.sessionCode).toBe(created.sessionCode);
      expect(joined.peers).toHaveLength(1);
      expect(joined.peers[0]?.agent.name).toBe("paul-agent");

      const paulStatus = await paul.getSessionStatus();
      expect(paulStatus.sessionId).toBe(created.sessionId);
      expect(paulStatus.peers).toHaveLength(1);
      expect(paulStatus.peers[0]?.agent.name).toBe("kelvin-agent");

      // Bidirectional bearers: each side holds an outbound token for the other
      // and an accepted inbound credential scoped to that participant.
      expect(joined.peers[0]?.outboundBearer).toBeTruthy();
      expect(paulStatus.peers[0]?.outboundBearer).toBeTruthy();
      expect(joined.security.authenticated).toBe(true);
      expect(paulStatus.security.activeCredentials).toHaveLength(1);
      expect(paulStatus.security.activeCredentials[0]?.participantId).toBe(
        paulStatus.peers[0]?.participant.id
      );

      const reloadedPaul = new SessionManager({ stateStore: creatorStore });
      const reloadedKelvin = new SessionManager({ stateStore: joinerStore });
      expect((await reloadedPaul.getSessionStatus()).sessionId).toBe(created.sessionId);
      expect((await reloadedKelvin.getSessionStatus()).sessionId).toBe(created.sessionId);
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 25_000);

  it("rejects join when peer lacks PairMesh session skill", async () => {
    const { joinerStore } = await tempStatePair();
    const echoOnlyAgent = createPairMeshA2AAgent({
      name: "echo-only-agent",
      host: "127.0.0.1",
      port: 4413,
      skills: "echo-only"
    });

    try {
      await waitUntilReachable(echoOnlyAgent.agentCardUrl);
      const kelvin = new SessionManager({ stateStore: joinerStore });

      await expect(
        kelvin.joinSession({
          sessionCode: "PM-ABC234",
          peerUrl: echoOnlyAgent.baseUrl,
          inviteSecret: generateInviteSecret(),
          name: "kelvin-agent",
          agentUrl: "http://127.0.0.1:4414"
        })
      ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });
    } finally {
      await echoOnlyAgent.close();
    }
  }, 20_000);

  it("returns PairMesh application error for invalid session code", async () => {
    const { creatorStore, joinerStore, creatorPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4415
    });

    try {
      await waitUntilReachable(paulAgent.agentCardUrl);
      const paul = new SessionManager({ stateStore: creatorStore });
      await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      const identity = createLocalPairMeshIdentity("kelvin-agent", "http://127.0.0.1:4416");
      const response = await sendPairMeshJoinRequest(
        paulAgent.baseUrl,
        buildJoinRequest("PM-XXXXXX", identity, "http://127.0.0.1:4416", {
          inviteSecret: generateInviteSecret(),
          offeredInboundBearer: generateBearerToken()
        })
      );

      expect(response.accepted).toBe(false);
      if (!response.accepted) {
        expect(response.error.code).toBe("pairmesh.session_not_found");
      }

      const kelvin = new SessionManager({ stateStore: joinerStore });
      await expect(
        kelvin.joinSession({
          sessionCode: "PM-XXXXXX",
          peerUrl: paulAgent.baseUrl,
          inviteSecret: generateInviteSecret(),
          name: "kelvin-agent",
          agentUrl: "http://127.0.0.1:4416"
        })
      ).rejects.toMatchObject({ code: "pairmesh.session_not_found" });
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await paulAgent.close();
    }
  }, 20_000);

  it("returns pairmesh.session_closed for closed creator sessions", async () => {
    const { creatorStore, creatorPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4417
    });

    try {
      await waitUntilReachable(paulAgent.agentCardUrl);
      const paul = new SessionManager({ stateStore: creatorStore });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      const closed = await creatorStore.load();
      if (!closed) {
        throw new Error("Expected creator state");
      }
      await creatorStore.save({
        ...closed,
        session: { ...closed.session, status: "closed" }
      });

      const identity = createLocalPairMeshIdentity("kelvin-agent", "http://127.0.0.1:4418");
      const response = await sendPairMeshJoinRequest(
        paulAgent.baseUrl,
        buildJoinRequest(created.sessionCode, identity, "http://127.0.0.1:4418", {
          inviteSecret: created.invite.inviteSecret,
          offeredInboundBearer: generateBearerToken()
        })
      );

      expect(response.accepted).toBe(false);
      if (!response.accepted) {
        expect(response.error.code).toBe("pairmesh.session_closed");
      }
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await paulAgent.close();
    }
  }, 20_000);

  it("handles duplicate joins idempotently without duplicate peers", async () => {
    const { creatorStore, joinerStore, creatorPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4419
    });

    try {
      await waitUntilReachable(paulAgent.agentCardUrl);
      const paul = new SessionManager({ stateStore: creatorStore });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      const kelvin = new SessionManager({ stateStore: joinerStore });
      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: "http://127.0.0.1:4420"
      });

      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: "http://127.0.0.1:4420"
      });

      const paulStatus = await paul.getSessionStatus();
      expect(paulStatus.peers).toHaveLength(1);
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await paulAgent.close();
    }
  }, 20_000);

  it("allows leave then re-join with a fresh invite when the agent id is reminted", async () => {
    const { creatorStore, joinerStore, creatorPath, joinerPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4423
    });
    process.env.PAIRMESH_STATE_FILE = joinerPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4424
    });
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({ stateStore: creatorStore });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      const kelvin = new SessionManager({ stateStore: joinerStore });
      const firstJoin = await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });
      const firstAgentId = (await joinerStore.load())?.localParticipant.agent.id;
      expect(firstAgentId).toBeTruthy();

      await kelvin.leaveSession();
      const reissued = await paul.createSessionInvite();
      const rejoined = await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: reissued.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      const secondAgentId = (await joinerStore.load())?.localParticipant.agent.id;
      expect(secondAgentId).toBeTruthy();
      expect(secondAgentId).not.toBe(firstAgentId);
      expect(rejoined.sessionId).toBe(firstJoin.sessionId);
      expect(rejoined.peers).toHaveLength(1);
      expect((await paul.getSessionStatus()).peers).toHaveLength(1);
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 25_000);

  it("supports session-aware send after handshake using canonical SessionId", async () => {
    const { creatorStore, joinerStore, creatorPath, joinerPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4421
    });
    // Each agent binds the state file current at creation time.
    process.env.PAIRMESH_STATE_FILE = joinerPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4422
    });
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({ stateStore: creatorStore });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      const kelvin = new SessionManager({ stateStore: joinerStore });
      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      const result = await paul.sendToPeer("kelvin-agent", "Hello from Paul");
      expect(result.responseText).toBe("PairMesh peer received: Hello from Paul");
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 25_000);
});
