import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

async function allocateEphemeralPort(host = "127.0.0.1"): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
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
      // continue
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

describe("Stage 14 source-reference isolation (multi-peer)", () => {
  it("Kelvin returns refs; Sarah completes with references stripped until grant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-source-ref-"));
    const creatorPath = join(dir, "creator.json");
    const kelvinPath = join(dir, "kelvin.json");
    const sarahPath = join(dir, "sarah.json");
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    const previousFakeDelay = process.env.PAIRMESH_FAKE_AGENT_DELAY_MS;

    process.env.PAIRMESH_STATE_FILE = creatorPath;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
    process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = "0";

    const inspectionTiming = {
      interactiveWaitMs: 800,
      mcpWaitForInspectionMs: 2_000,
      mcpMaxWaitMs: 4_000,
      duplicateQuestionWindowMs: 45_000,
      pollIntervalMs: 50,
      maxDurationMs: 120_000
    };

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: await allocateEphemeralPort()
    });
    process.env.PAIRMESH_STATE_FILE = kelvinPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: await allocateEphemeralPort()
    });
    process.env.PAIRMESH_STATE_FILE = sarahPath;
    const sarahAgent = createPairMeshA2AAgent({
      name: "sarah-agent",
      host: "127.0.0.1",
      port: await allocateEphemeralPort()
    });
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl),
        waitUntilReachable(sarahAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: creatorPath }),
        skipPeerHealthPreflight: true,
        inspectionTiming
      });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      process.env.PAIRMESH_STATE_FILE = kelvinPath;
      const kelvin = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: kelvinPath }),
        inspectionTiming
      });
      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      const sarahInvite = await paul.createSessionInvite();
      process.env.PAIRMESH_STATE_FILE = sarahPath;
      const sarah = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: sarahPath }),
        inspectionTiming
      });
      await sarah.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: sarahInvite.inviteSecret,
        name: "sarah-agent",
        agentUrl: sarahAgent.baseUrl
      });

      await kelvin.setPeerCapability("paul-agent", "repository.inspect", "allow_session");
      await kelvin.setPeerCapability("paul-agent", "repository.source_references", "allow_session");
      await sarah.setPeerCapability("paul-agent", "repository.inspect", "allow_session");
      await sarah.setPeerCapability("paul-agent", "repository.source_references", "deny");

      process.env.PAIRMESH_STATE_FILE = creatorPath;
      const kelvinQ = "What fields does the successful payment response contain?";
      const sarahQ = "Where does paymentReference appear in the payment response?";

      // Sequential asks: parallel dual-ask races under full CI suite load.
      const kelvinResult = await paul.askPeer("kelvin-agent", kelvinQ);
      const sarahResult = await paul.askPeer("sarah-agent", sarahQ);

      expect(kelvinResult.completed).toBe(true);
      expect(sarahResult.completed).toBe(true);
      expect(kelvinResult.references?.length ?? 0).toBeGreaterThan(0);
      expect(sarahResult.references ?? []).toEqual([]);
      expect((sarahResult.summary ?? "").length).toBeGreaterThan(0);

      await sarah.setPeerCapability("paul-agent", "repository.source_references", "allow_session");
      const sarahRestored = await paul.askPeer(
        "sarah-agent",
        "How does a webhook eventually produce the successful payment response?"
      );
      expect(sarahRestored.completed).toBe(true);
      expect(sarahRestored.references?.length ?? 0).toBeGreaterThan(0);

      const kelvinPerms = await kelvin.listPeerPermissions("paul-agent");
      expect(
        kelvinPerms[0]?.grants.find((g) => g.capabilityId === "repository.source_references")
          ?.policy
      ).toBe("allow_session");
    } finally {
      await Promise.allSettled([paulAgent.close(), kelvinAgent.close(), sarahAgent.close()]);
      if (previousStateFile === undefined) {
        delete process.env.PAIRMESH_STATE_FILE;
      } else {
        process.env.PAIRMESH_STATE_FILE = previousStateFile;
      }
      if (previousProvider === undefined) {
        delete process.env.PAIRMESH_CODING_AGENT_PROVIDER;
      } else {
        process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
      }
      if (previousWorkspace === undefined) {
        delete process.env.PAIRMESH_WORKSPACE;
      } else {
        process.env.PAIRMESH_WORKSPACE = previousWorkspace;
      }
      if (previousFakeDelay === undefined) {
        delete process.env.PAIRMESH_FAKE_AGENT_DELAY_MS;
      } else {
        process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = previousFakeDelay;
      }
    }
  }, 60_000);
});
