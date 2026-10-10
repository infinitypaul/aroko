import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import { createPairMeshMcpServer } from "./create-server.js";

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
}> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-a2a-"));
  const creatorPath = join(dir, "creator.json");
  return {
    creatorPath,
    creatorStore: new LocalStateStore({ stateFilePath: creatorPath }),
    joinerStore: new LocalStateStore({ stateFilePath: join(dir, "joiner.json") })
  };
}

describe("pairmesh_send A2A integration", () => {
  it("returns deterministic echo through MCP tool result", async () => {
    const { creatorStore, joinerStore, creatorPath } = await tempStatePair();
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4521
    });
    // Each agent binds the state file current at creation time.
    process.env.PAIRMESH_STATE_FILE = joinerStore.stateFilePath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4522
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

      const paulStatus = await paul.getSessionStatus();
      expect(paulStatus.peers).toHaveLength(1);
      expect(paulStatus.peers[0]?.agent.name).toBe("kelvin-agent");

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createPairMeshMcpServer(paul);
      await server.connect(serverTransport);

      const client = new Client({ name: "pairmesh-mcp-a2a-test", version: "0.0.0" });
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "pairmesh_send",
          arguments: { peer: "kelvin-agent", message: "Hello from MCP" }
        });

        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          peer: string;
          request: string;
          response: string;
        };
        expect(structured.peer).toBe("kelvin-agent");
        expect(structured.request).toBe("Hello from MCP");
        expect(structured.response).toContain("PairMesh peer received: Hello from MCP");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 30_000);
});
