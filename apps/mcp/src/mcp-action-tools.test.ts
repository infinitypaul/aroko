import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer } from "./create-server.js";
import { assertTestsRunProfileOnly } from "./tools/handlers.js";

const ACTION_TOOLS = [
  "pairmesh_propose_change",
  "pairmesh_request_apply",
  "pairmesh_run_tests",
  "pairmesh_execute_process",
  "pairmesh_action_status",
  "pairmesh_wait_for_action",
  "pairmesh_cancel_action"
] as const;

describe("MCP controlled-action tools", () => {
  it("registers the six action tools and never registers approve", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "create-server.ts"), "utf8");
    const registered = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);

    for (const tool of ACTION_TOOLS) {
      expect(registered).toContain(tool);
    }
    expect(registered).not.toContain("pairmesh_approve");
    expect(registered).not.toContain("pairmesh_action_approve");
    expect(registered).not.toContain("pairmesh_approve_action");

    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mcp-action-"));
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: join(dir, "state.json") })
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPairMeshMcpServer(manager);
    await server.connect(serverTransport);
    const client = new Client({ name: "pairmesh-mcp-action-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const tool of ACTION_TOOLS) {
        expect(names).toContain(tool);
      }
      expect(names).not.toContain("pairmesh_approve");
      expect(names).not.toContain("pairmesh_action_approve");

      const runTests = listed.tools.find((tool) => tool.name === "pairmesh_run_tests");
      expect(runTests?.description).toMatch(/profile name only/i);
      expect(runTests?.description).toMatch(/executable|args|cwd|env/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("run_tests handler rejects executable/args/cwd/env", () => {
    expect(() => assertTestsRunProfileOnly({ profile: "unit", executable: "/bin/sh" })).toThrow(
      /profile name/
    );
    expect(() => assertTestsRunProfileOnly({ profile: "unit", args: ["-c", "true"] })).toThrow(
      /profile name/
    );
    expect(() => assertTestsRunProfileOnly({ profile: "unit", cwd: "/tmp" })).toThrow(
      /profile name/
    );
    expect(() => assertTestsRunProfileOnly({ profile: "unit", env: { FOO: "1" } })).toThrow(
      /profile name/
    );
    expect(() => assertTestsRunProfileOnly({ profile: "unit" })).not.toThrow();
  });
});
