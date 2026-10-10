import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer } from "./create-server.js";

/** PairMesh targets the MCP v2 modern specification revision (SDK era: `modern`). */
export const PAIRMESH_MCP_SPEC_REVISION = "2026-07-28" as const;

async function withServeStdioClient(
  sessionManager: SessionManager,
  clientOptions: ConstructorParameters<typeof Client>[1] | undefined,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createPairMeshMcpServer(sessionManager), {
    transport: serverTransport
  });

  const client = new Client(
    { name: "pairmesh-mcp-protocol-test", version: "0.0.0" },
    clientOptions
  );

  try {
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await handle.close();
  }
}

describe("PairMesh MCP protocol era (serveStdio entry)", () => {
  it("initializes in the modern era when the client pins 2026-07-28", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-modern-"));
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: join(dir, "state.json") })
    });

    await withServeStdioClient(
      manager,
      { versionNegotiation: { mode: { pin: PAIRMESH_MCP_SPEC_REVISION } } },
      async (client) => {
        expect(client.getProtocolEra()).toBe("modern");
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
          [
            "pairmesh_action_status",
            "pairmesh_ask",
            "pairmesh_ask_peer",
            "pairmesh_cancel_action",
            "pairmesh_cancel_inspection",
            "pairmesh_close_thread",
            "pairmesh_follow_up",
            "pairmesh_get_thread",
            "pairmesh_inspection_status",
            "pairmesh_list_peers",
            "pairmesh_list_threads",
            "pairmesh_peer_health",
            "pairmesh_propose_change",
            "pairmesh_request_apply",
            "pairmesh_run_tests",
            "pairmesh_execute_process",
            "pairmesh_send",
            "pairmesh_status",
            "pairmesh_wait_for_action",
            "pairmesh_wait_for_inspection"
          ].sort()
        );
      }
    );
  });

  it("serves legacy initialize clients through the same serveStdio entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-legacy-"));
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: join(dir, "state.json") })
    });

    await withServeStdioClient(manager, undefined, async (client) => {
      expect(client.getProtocolEra()).toBe("legacy");
      const listed = await client.listTools();
      expect(listed.tools.length).toBe(20);
    });
  });
});
