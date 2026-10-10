import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer } from "./create-server.js";
import { toolSuccess } from "./errors.js";

function textBlocks(result: CallToolResult): string[] {
  return (result.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text);
}

describe("MCP text presentation", () => {
  it("does not dump raw JSON into tool text content", () => {
    const result = toolSuccess({ connected: false, pairmeshBuildId: "x" }, "Not connected.");
    const texts = textBlocks(result);
    expect(texts).toEqual(["Not connected."]);
    expect(result.structuredContent).toMatchObject({ connected: false });
  });

  it("pairmesh_status text stays human and omits JSON blobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-text-"));
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: join(dir, "state.json") })
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPairMeshMcpServer(manager);
    await server.connect(serverTransport);
    const client = new Client({ name: "text-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "pairmesh_status", arguments: {} });
      const texts = textBlocks(result as CallToolResult);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toMatch(/Not connected|Connected/);
      expect(texts[0]).not.toMatch(/^\s*\{/);
      expect(texts.join("\n")).not.toContain('"pairmeshBuildId"');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
