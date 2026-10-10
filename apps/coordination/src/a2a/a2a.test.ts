import { ClientFactory } from "@a2a-js/sdk/client";
import { LocalStateStore, SessionManager, issueInboundCredential } from "@pairmesh/client";
import { PAIRMESH_BEARER_SECURITY_SCHEME } from "@pairmesh/protocol";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createPairMeshA2AAgent,
  createPairMeshAgentCard,
  createPairMeshEchoAgentCard,
  sendToPairMeshPeer
} from "./index.js";

async function waitUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  // Small polling loop for local startup readiness.
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

describe("PairMesh A2A demo agent card", () => {
  it("exposes a valid card with the pairmesh.echo skill", async () => {
    const card = createPairMeshEchoAgentCard({
      name: "demo-agent",
      host: "127.0.0.1",
      port: 4102
    });

    const skill = card.skills.find((entry) => entry.id === "pairmesh.echo");
    const sessionSkill = card.skills.find((entry) => entry.id === "pairmesh.session");
    expect(skill?.name).toBe("PairMesh Echo");
    expect(sessionSkill?.name).toBe("PairMesh Session");
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe("JSONRPC");
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe("1.0");

    await expect(new ClientFactory().createFromAgentCard(card)).resolves.toBeDefined();
  });

  it("advertises HTTP bearer auth and requires it for the inspect skill", () => {
    const card = createPairMeshAgentCard({
      name: "demo-agent",
      host: "127.0.0.1",
      port: 4103,
      skills: "full"
    });

    const scheme = card.securitySchemes?.[PAIRMESH_BEARER_SECURITY_SCHEME]?.scheme;
    expect(scheme?.$case).toBe("httpAuthSecurityScheme");
    if (scheme?.$case === "httpAuthSecurityScheme") {
      expect(scheme.value.scheme).toBe("Bearer");
    }

    const inspect = card.skills.find((entry) => entry.id === "pairmesh.inspect");
    expect(
      inspect?.securityRequirements?.[0]?.schemes?.[PAIRMESH_BEARER_SECURITY_SCHEME]
    ).toBeDefined();

    const action = card.skills.find((entry) => entry.id === "pairmesh.action");
    expect(action?.name).toBe("PairMesh Action");
    expect(
      action?.securityRequirements?.[0]?.schemes?.[PAIRMESH_BEARER_SECURITY_SCHEME]
    ).toBeDefined();

    const session = card.skills.find((entry) => entry.id === "pairmesh.session");
    expect(session?.securityRequirements).toEqual([]);
    expect(session?.description).toMatch(/invite secret/i);
    expect(JSON.stringify(card)).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
  });
});

describe("PairMesh A2A demo request flow", () => {
  it("sends an actual A2A request from one paired agent context to another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-a2a-"));
    const statePath = join(dir, "state.json");
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = statePath;

    const store = new LocalStateStore({ stateFilePath: statePath });
    const manager = new SessionManager({ stateStore: store });

    const agentA = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4311
    });

    const agentB = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4312
    });

    try {
      await waitUntilReachable(agentB.agentCardUrl);

      // Network reachability alone is not authorization: the receiver refuses
      // messages without a session credential (ADR 0027).
      await expect(
        sendToPairMeshPeer({ target: agentB.baseUrl, message: "Hello from a stranger" })
      ).rejects.toThrow(/authentication_required/);

      await manager.createSession({ name: "kelvin-agent", agentUrl: agentB.baseUrl });
      const state = await store.load();
      if (!state?.sessionSecurity) {
        throw new Error("expected an authenticated session");
      }
      const caller = { ...state.localParticipant, isLocal: false };
      const issued = issueInboundCredential(caller.participant.id);
      await store.save({
        ...state,
        peers: [caller],
        sessionSecurity: {
          ...state.sessionSecurity,
          acceptedInbound: [issued.credential]
        }
      });

      const result = await sendToPairMeshPeer({
        target: agentB.baseUrl,
        message: "Hello from Paul",
        bearerToken: issued.token
      });

      expect(result.requestText).toBe("Hello from Paul");
      expect(result.responseText).toBe("PairMesh peer received: Hello from Paul");
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await Promise.all([agentA.close(), agentB.close()]);
    }
  }, 20_000);

  it("keeps PairMesh and A2A/network errors distinguishable", async () => {
    await expect(
      sendToPairMeshPeer({
        target: "not-a-url",
        message: "hello"
      })
    ).rejects.toMatchObject({
      code: "pairmesh.invalid_metadata"
    });

    await expect(
      sendToPairMeshPeer({
        target: "http://127.0.0.1:59999",
        message: "hello"
      })
    ).rejects.not.toMatchObject({
      code: expect.stringMatching(/^pairmesh\./)
    });
  });
});
