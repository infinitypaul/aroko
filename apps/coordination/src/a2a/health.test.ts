import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PeerIdSchema } from "@pairmesh/protocol";
import { createPairMeshA2AAgent } from "./index.js";
import {
  fetchPeerHealth,
  clearPeerHealthCache,
  issueInboundCredential,
  generateBearerToken,
  LocalStateStore,
  SessionManager
} from "@pairmesh/client";

async function waitUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // continue
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

describe("GET /health", () => {
  it("returns safe JSON without workspace paths", async () => {
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = `${process.cwd()}/fixtures/payment-workspace`;

    const agent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4572
    });

    try {
      const healthUrl = `${agent.baseUrl}/health`;
      await waitUntilReachable(healthUrl);
      const response = await fetch(healthUrl);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agent.name).toBe("kelvin-agent");
      expect(body.codingAgent.provider).toBe("fake");
      expect(typeof body.readyForInspection).toBe("boolean");
      expect(JSON.stringify(body)).not.toMatch(/\/Users\/|PAIRMESH|\.json|fixtures/);
    } finally {
      process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
      process.env.PAIRMESH_WORKSPACE = previousWorkspace;
      await agent.close();
    }
  }, 20_000);

  it("returns reachable peer health summary via fetchPeerHealth", async () => {
    clearPeerHealthCache();
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = `${process.cwd()}/fixtures/payment-workspace`;

    const agent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4573
    });

    try {
      await waitUntilReachable(`${agent.baseUrl}/health`);
      const health = await fetchPeerHealth("kelvin-agent", agent.baseUrl, { skipCache: true });
      expect(health.reachable).toBe(true);
      if (health.reachable) {
        expect(health.codingAgent.provider).toBe("fake");
      }
    } finally {
      process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
      process.env.PAIRMESH_WORKSPACE = previousWorkspace;
      await agent.close();
    }
  }, 20_000);

  it("withholds coding-agent detail when bearer is invalid even on loopback", async () => {
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = `${process.cwd()}/fixtures/payment-workspace`;

    const dir = await mkdtemp(join(tmpdir(), "pairmesh-health-auth-"));
    const statePath = join(dir, "state.json");
    process.env.PAIRMESH_STATE_FILE = statePath;

    const store = new LocalStateStore({ stateFilePath: statePath });
    const manager = new SessionManager({ stateStore: store });
    const agent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4574
    });

    try {
      await waitUntilReachable(`${agent.baseUrl}/health`);
      await manager.createSession({ name: "kelvin-agent", agentUrl: agent.baseUrl });
      const state = await store.load();
      if (!state?.sessionSecurity) {
        throw new Error("expected authenticated session");
      }
      const callerParticipantId = PeerIdSchema.parse(`peer_${randomUUID()}`);
      const issued = issueInboundCredential(callerParticipantId);
      const peerRecord = {
        ...state.localParticipant,
        participant: {
          ...state.localParticipant.participant,
          id: callerParticipantId
        },
        isLocal: false,
        a2aAgentUrl: "http://127.0.0.1:4999",
        outboundBearer: generateBearerToken()
      };
      await store.save({
        ...state,
        peers: [peerRecord],
        sessionSecurity: {
          ...state.sessionSecurity,
          acceptedInbound: [issued.credential]
        }
      });

      const healthUrl = `${agent.baseUrl}/health`;
      const badBearerResponse = await fetch(healthUrl, {
        headers: { Authorization: "Bearer pm_bearer_invalid_token_for_test" }
      });
      expect(badBearerResponse.status).toBe(200);
      const badBody = await badBearerResponse.json();
      expect(badBody.codingAgent).toBeUndefined();

      const goodResponse = await fetch(healthUrl, {
        headers: { Authorization: `Bearer ${issued.token}` }
      });
      expect(goodResponse.status).toBe(200);
      const goodBody = await goodResponse.json();
      expect(goodBody.codingAgent?.provider).toBe("fake");
    } finally {
      process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
      process.env.PAIRMESH_WORKSPACE = previousWorkspace;
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await agent.close();
    }
  }, 20_000);
});
