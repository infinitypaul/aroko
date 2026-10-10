#!/usr/bin/env tsx
/**
 * Programmatic MCP tool demo (InMemoryTransport).
 * Run from repo root: pnpm exec tsx apps/mcp/scripts/demo-tools.mts
 */
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPairMeshMcpServer } from "../src/create-server.js";

async function waitUntilReachable(url: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-demo-"));
  const creatorPath = join(dir, "creator.json");
  const joinerPath = join(dir, "joiner.json");
  const previousStateFile = process.env.PAIRMESH_STATE_FILE;
  process.env.PAIRMESH_STATE_FILE = creatorPath;

  const paulAgent = createPairMeshA2AAgent({ name: "paul-agent", host: "127.0.0.1", port: 4531 });
  const kelvinAgent = createPairMeshA2AAgent({
    name: "kelvin-agent",
    host: "127.0.0.1",
    port: 4532
  });

  try {
    await Promise.all([
      waitUntilReachable(paulAgent.agentCardUrl),
      waitUntilReachable(kelvinAgent.agentCardUrl)
    ]);

    const paul = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: creatorPath })
    });
    const created = await paul.createSession({ name: "paul-agent", agentUrl: paulAgent.baseUrl });

    const kelvin = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: joinerPath })
    });
    await kelvin.joinSession({
      sessionCode: created.sessionCode,
      peerUrl: paulAgent.baseUrl,
      name: "kelvin-agent",
      agentUrl: kelvinAgent.baseUrl
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPairMeshMcpServer(paul);
    await server.connect(serverTransport);
    const client = new Client({ name: "pairmesh-demo", version: "0.0.0" });
    await client.connect(clientTransport);

    const status = await client.callTool({ name: "pairmesh_status", arguments: {} });
    console.log("pairmesh_status:", JSON.stringify(status.structuredContent, null, 2));

    const peers = await client.callTool({ name: "pairmesh_list_peers", arguments: {} });
    console.log("pairmesh_list_peers:", JSON.stringify(peers.structuredContent, null, 2));

    const send = await client.callTool({
      name: "pairmesh_send",
      arguments: { peer: "kelvin-agent", message: "Hello from Cursor" }
    });
    console.log("pairmesh_send:", JSON.stringify(send.structuredContent, null, 2));

    await client.close();
    await server.close();
  } finally {
    process.env.PAIRMESH_STATE_FILE = previousStateFile;
    await Promise.all([paulAgent.close(), kelvinAgent.close()]);
  }
}

void main();
