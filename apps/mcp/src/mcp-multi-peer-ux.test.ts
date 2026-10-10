import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { findExecutionRecord } from "@pairmesh/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer } from "./create-server.js";
import { addConfiguredPeer } from "./test-helpers.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

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

function structuredContent(result: { structuredContent?: unknown }): unknown {
  return result.structuredContent;
}

describe("Stage 14 MCP multi-peer UX", () => {
  it("list_peers returns SafePeerView-shaped fields and ask_peer description targets one peer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-ux-"));
    const statePath = join(dir, "state.json");
    const store = new LocalStateStore({ stateFilePath: statePath });
    const manager = new SessionManager({ stateStore: store, skipPeerHealthPreflight: true });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4571" });
    await addConfiguredPeer(store, {
      name: "kelvin-agent",
      a2aAgentUrl: "http://127.0.0.1:4572"
    });
    const loaded = await store.load();
    if (!loaded?.peers[0]) throw new Error("peer required");
    loaded.peers[0] = { ...loaded.peers[0], serviceLabel: "payments" };
    await store.save(loaded);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPairMeshMcpServer(manager);
    await server.connect(serverTransport);
    const client = new Client({ name: "pairmesh-ux-test", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain("pairmesh_list_peers");
      expect(toolNames).toContain("pairmesh_ask_peer");
      expect(toolNames).not.toContain("pairmesh_ask_peers");

      const askTool = tools.tools.find((t) => t.name === "pairmesh_ask_peer");
      expect(askTool?.description ?? "").toMatch(/exactly one peer/i);
      expect(askTool?.description ?? "").toMatch(/Never broadcasts|never broadcast/i);
      expect(askTool?.description ?? "").toMatch(/participantId/i);

      const listTool = tools.tools.find((t) => t.name === "pairmesh_list_peers");
      expect(listTool?.description ?? "").toMatch(/Membership ≠ paired ≠ reachable|membership/i);

      const listed = await client.callTool({ name: "pairmesh_list_peers", arguments: {} });
      const body = structuredContent(listed) as {
        peers: Array<{
          id: string;
          participantId: string;
          displayName: string;
          name: string;
          agentName: string;
          agentId: string;
          service?: string;
          relationship: string;
          connectivity: string;
        }>;
      };
      expect(body.peers).toHaveLength(1);
      expect(body.peers[0]).toMatchObject({
        id: loaded.peers[0].participant.id,
        participantId: loaded.peers[0].participant.id,
        displayName: "kelvin-agent",
        name: "kelvin-agent",
        agentName: "kelvin-agent",
        service: "payments",
        relationship: "paired"
      });
      expect(JSON.stringify(body)).not.toMatch(/outboundBearer|inviteSecret|\/Users\//);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("concurrent askPeer to two peers isolates results; cancel one does not cancel the other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-concurrent-"));
    const creatorPath = join(dir, "creator.json");
    const kelvinPath = join(dir, "kelvin.json");
    const sarahPath = join(dir, "sarah.json");
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;
    const previousDelay = process.env.PAIRMESH_FAKE_AGENT_DELAY_MS;

    process.env.PAIRMESH_STATE_FILE = creatorPath;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
    process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = "400";

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 14581
    });
    process.env.PAIRMESH_STATE_FILE = kelvinPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 14582
    });
    process.env.PAIRMESH_STATE_FILE = sarahPath;
    const sarahAgent = createPairMeshA2AAgent({
      name: "sarah-agent",
      host: "127.0.0.1",
      port: 14583
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
        inspectionTiming: {
          interactiveWaitMs: 800,
          mcpWaitForInspectionMs: 2_000,
          mcpMaxWaitMs: 4_000,
          duplicateQuestionWindowMs: 45_000,
          pollIntervalMs: 50,
          maxDurationMs: 120_000
        }
      });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      process.env.PAIRMESH_STATE_FILE = kelvinPath;
      const kelvin = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: kelvinPath })
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
        stateStore: new LocalStateStore({ stateFilePath: sarahPath })
      });
      await sarah.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: sarahInvite.inviteSecret,
        name: "sarah-agent",
        agentUrl: sarahAgent.baseUrl
      });

      process.env.PAIRMESH_STATE_FILE = creatorPath;
      const paulStore = new LocalStateStore({ stateFilePath: creatorPath });
      const status = await paul.getSessionStatus();
      expect(status.peers).toHaveLength(2);

      const slowQuestion =
        "Take your time answering: What fields does the successful payment response contain?";

      const askKelvin = paul.askPeer("kelvin-agent", `${slowQuestion} (for kelvin)`);
      const askSarah = paul.askPeer("sarah-agent", `${slowQuestion} (for sarah)`);

      // CI runners are slower; poll until both concurrent executions are recorded.
      let midState = await paulStore.load();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const count = midState?.inspectionExecutions.length ?? 0;
        const unique =
          new Set(midState?.inspectionExecutions.map((row) => row.requestId)).size ?? 0;
        if (count >= 2 && unique >= 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        midState = await paulStore.load();
      }
      expect(midState?.inspectionExecutions.length).toBeGreaterThanOrEqual(2);
      expect(
        new Set(midState?.inspectionExecutions.map((row) => row.requestId)).size
      ).toBeGreaterThanOrEqual(2);

      const [kelvinResult, sarahResult] = await Promise.all([askKelvin, askSarah]);

      expect(kelvinResult.peer).toBe("kelvin-agent");
      expect(sarahResult.peer).toBe("sarah-agent");
      expect(kelvinResult.requestId).not.toBe(sarahResult.requestId);
      expect(kelvinResult.threadId).not.toBe(sarahResult.threadId);
      expect(kelvinResult.safePeer?.participantId).toBeTruthy();
      expect(sarahResult.safePeer?.participantId).toBeTruthy();
      expect(kelvinResult.safePeer?.participantId).not.toBe(sarahResult.safePeer?.participantId);

      const finalState = await paulStore.load();
      expect(findExecutionRecord(finalState!, kelvinResult.requestId)).toBeDefined();
      expect(findExecutionRecord(finalState!, sarahResult.requestId)).toBeDefined();

      const statusKelvin = await paul.getInspectionStatus(kelvinResult.requestId);
      const statusSarah = await paul.getInspectionStatus(sarahResult.requestId);
      expect(statusKelvin.requestId).toBe(kelvinResult.requestId);
      expect(statusSarah.requestId).toBe(sarahResult.requestId);

      // Cancel kelvin's request (if still working) must not cancel sarah's.
      if (!kelvinResult.completed) {
        await paul.cancelInspection(kelvinResult.requestId);
      }
      if (!sarahResult.completed) {
        const waited = await paul.waitForInspection(sarahResult.requestId, { waitMs: 8_000 });
        expect(waited.requestId).toBe(sarahResult.requestId);
        if (waited.status === "cancelled") {
          throw new Error("cancelling kelvin cancelled sarah");
        }
      } else {
        expect(sarahResult.completed).toBe(true);
      }
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
      if (previousDelay === undefined) {
        delete process.env.PAIRMESH_FAKE_AGENT_DELAY_MS;
      } else {
        process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = previousDelay;
      }
    }
  }, 60_000);
});
