import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer, PAIRMESH_MCP_SERVER_NAME } from "./create-server.js";
import { addConfiguredPeer } from "./test-helpers.js";

const EXPECTED_TOOLS = [
  "pairmesh_status",
  "pairmesh_list_peers",
  "pairmesh_ask",
  "pairmesh_send",
  "pairmesh_ask_peer",
  "pairmesh_follow_up",
  "pairmesh_list_threads",
  "pairmesh_get_thread",
  "pairmesh_close_thread",
  "pairmesh_peer_health",
  "pairmesh_inspection_status",
  "pairmesh_wait_for_inspection",
  "pairmesh_cancel_inspection",
  "pairmesh_propose_change",
  "pairmesh_request_apply",
  "pairmesh_run_tests",
  "pairmesh_execute_process",
  "pairmesh_action_status",
  "pairmesh_wait_for_action",
  "pairmesh_cancel_action"
] as const;

async function withMcpClient(
  sessionManager: SessionManager,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPairMeshMcpServer(sessionManager);
  await server.connect(serverTransport);

  const client = new Client({ name: "pairmesh-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);

  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function structuredContent(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

async function tempStatePath(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-"));
  return join(dir, `${label}.json`);
}

describe("PairMesh MCP server", () => {
  it("initializes and registers expected tools", async () => {
    const statePath = await tempStatePath("startup");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: statePath })
    });

    await withMcpClient(manager, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
      expect(listed.tools.every((tool) => tool.description && tool.description.length > 0)).toBe(
        true
      );
    });
  });

  it("uses the pairmesh server name", () => {
    expect(PAIRMESH_MCP_SERVER_NAME).toBe("pairmesh");
  });
});

describe("pairmesh_status", () => {
  it("returns connected=false when no session exists", async () => {
    const statePath = await tempStatePath("no-session");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: statePath })
    });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({ name: "pairmesh_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      const body = structuredContent(result);
      expect(body.connected).toBe(false);
      expect(body.pairmeshVersion).toBeTruthy();
      expect(body.pairmeshBuildId).toBeTruthy();
      expect(JSON.stringify(result)).not.toMatch(
        /\.json|PAIRMESH_STATE|PAIRMESH_PROJECT|\/Users\//
      );
    });
  });

  it("returns structured active session status", async () => {
    const statePath = await tempStatePath("active");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: statePath })
    });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4501" });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({ name: "pairmesh_status", arguments: {} });
      const body = structuredContent(result);
      expect(body.connected).toBe(true);
      expect(body.session).toMatchObject({
        status: "active"
      });
      expect(body.localAgent).toMatchObject({ name: "paul-agent" });
      expect(body.peerCount).toBe(0);
      expect(JSON.stringify(body)).not.toMatch(/\.json|PAIRMESH|\/Users\//);
    });
  });
});

describe("pairmesh_list_peers", () => {
  it("returns configured peers without filesystem details", async () => {
    const statePath = await tempStatePath("peers");
    const store = new LocalStateStore({ stateFilePath: statePath });
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4501" });

    const peer = await addConfiguredPeer(store, {
      name: "kelvin-agent",
      a2aAgentUrl: "http://127.0.0.1:4502"
    });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({ name: "pairmesh_list_peers", arguments: {} });
      const body = structuredContent(result) as {
        peers: Array<{
          id: string;
          participantId: string;
          displayName: string;
          name: string;
          agentName: string;
          agentId: string;
          relationship: string;
          connectivity: string;
        }>;
      };
      expect(body.peers).toEqual([
        {
          id: peer.participant.id,
          participantId: peer.participant.id,
          displayName: "kelvin-agent",
          name: "kelvin-agent",
          agentName: "kelvin-agent",
          agentId: peer.agent.id,
          relationship: "paired",
          connectivity: "offline"
        }
      ]);
      expect(JSON.stringify(body)).not.toMatch(/\.json|PAIRMESH|\/Users\/|a2aAgentUrl|4502/);
    });
  });

  it("returns an empty peer list for a solo session", async () => {
    const statePath = await tempStatePath("solo");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: statePath })
    });
    await manager.createSession({ name: "solo-agent", agentUrl: "http://127.0.0.1:4501" });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({ name: "pairmesh_list_peers", arguments: {} });
      const body = structuredContent(result) as { peers: unknown[] };
      expect(body.peers).toEqual([]);
    });
  });
});

describe("pairmesh_send error boundaries", () => {
  it("maps unknown PairMesh peer to pairmesh layer error", async () => {
    const statePath = await tempStatePath("unknown-peer");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: statePath })
    });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4501" });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({
        name: "pairmesh_send",
        arguments: { peer: "missing-peer", message: "hello" }
      });
      expect(result.isError).toBe(true);
      const body = structuredContent(result);
      expect(body.layer).toBe("pairmesh");
      expect(body.error).toMatchObject({ code: "pairmesh.peer_not_found" });
    });
  });

  it("rejects malformed MCP input at the protocol layer", async () => {
    const statePath = await tempStatePath("malformed");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: statePath })
    });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4501" });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({
        name: "pairmesh_send",
        arguments: { peer: "", message: "hello" }
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Input validation error")
      });
    });
  });

  it("maps unreachable A2A peer to a2a layer error", async () => {
    const statePath = await tempStatePath("unreachable");
    const store = new LocalStateStore({ stateFilePath: statePath });
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4501" });
    await addConfiguredPeer(store, {
      name: "kelvin-agent",
      a2aAgentUrl: "http://127.0.0.1:59999"
    });

    await withMcpClient(manager, async (client) => {
      const result = await client.callTool({
        name: "pairmesh_send",
        arguments: { peer: "kelvin-agent", message: "hello" }
      });
      expect(result.isError).toBe(true);
      const body = structuredContent(result);
      expect(body.layer).toBe("a2a");
      expect(body.error).toMatchObject({ message: expect.any(String) });
    });
  }, 20_000);
});
