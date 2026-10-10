import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer } from "./create-server.js";
import { addConfiguredPeer } from "./test-helpers.js";

function textContent(result: CallToolResult): string {
  const block = result.content.find((entry) => entry.type === "text");
  return block && "text" in block ? String(block.text) : "";
}

async function withMcpClient(
  sessionManager: SessionManager,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPairMeshMcpServer(sessionManager);
  await server.connect(serverTransport);
  const client = new Client({ name: "pairmesh-ask-natural-test", version: "0.0.0" });
  try {
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("pairmesh_ask natural orchestration", () => {
  it("requires intent and never registers approve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-ask-natural-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6201" });

    await withMcpClient(manager, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("pairmesh_ask");
      expect(names).not.toContain("pairmesh_approve");
      expect(names).not.toContain("pairmesh_action_approve");

      const ask = listed.tools.find((tool) => tool.name === "pairmesh_ask");
      expect(ask?.description).toMatch(/intent is REQUIRED/i);
      expect(ask?.description).toMatch(/never auto-applies/i);
      const schema = ask?.inputSchema as { required?: string[] } | undefined;
      expect(schema?.required).toEqual(expect.arrayContaining(["peer", "request", "intent"]));
    });
  });

  it("returns human disambiguation when peer is ambiguous", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-ask-ambiguous-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6202" });
    const payment = await addConfiguredPeer(store, {
      name: "Kelvin",
      a2aAgentUrl: "http://127.0.0.1:6203"
    });
    const billing = await addConfiguredPeer(store, {
      name: "Kelvin",
      a2aAgentUrl: "http://127.0.0.1:6204"
    });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");
    loaded.peers = loaded.peers.map((peer) => {
      if (peer.participant.id === payment.participant.id) {
        return { ...peer, serviceLabel: "payment-service" };
      }
      if (peer.participant.id === billing.participant.id) {
        return { ...peer, serviceLabel: "billing-service" };
      }
      return peer;
    });
    await store.save(loaded);

    await withMcpClient(manager, async (client) => {
      const result = (await client.callTool({
        name: "pairmesh_ask",
        arguments: {
          peer: "Kelvin",
          request: "Check why payment retries lose the reference",
          intent: "inspect"
        }
      })) as CallToolResult;
      const text = textContent(result);
      expect(text).toContain("I found 2 matches");
      expect(text).toContain("Kelvin · payment-service");
      expect(text).toContain("Kelvin · billing-service");
      expect(text).toContain("Which one?");
      expect(text).not.toMatch(/peer_/);
    });
  });
});
