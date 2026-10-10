import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshMcpServer } from "./create-server.js";

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

describe("pairmesh_ask_peer integration", () => {
  it("returns inspection findings through MCP -> A2A -> fake coding agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-inspect-"));
    const creatorPath = join(dir, "creator.json");
    const joinerPath = join(dir, "joiner.json");
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;

    process.env.PAIRMESH_STATE_FILE = creatorPath;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4541
    });
    // Each agent binds the state file current at creation time.
    process.env.PAIRMESH_STATE_FILE = joinerPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4542
    });
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: creatorPath }),
        skipPeerHealthPreflight: true,
        inspectionTiming: {
          interactiveWaitMs: 30_000,
          mcpWaitForInspectionMs: 4_000,
          mcpMaxWaitMs: 8_000,
          duplicateQuestionWindowMs: 45_000,
          pollIntervalMs: 100,
          maxDurationMs: 120_000
        }
      });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      process.env.PAIRMESH_STATE_FILE = joinerPath;
      const kelvin = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: joinerPath })
      });
      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      process.env.PAIRMESH_STATE_FILE = creatorPath;
      const paulStatus = await paul.getSessionStatus();
      expect(paulStatus.peers).toHaveLength(1);

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createPairMeshMcpServer(paul);
      await server.connect(serverTransport);
      const client = new Client({ name: "pairmesh-inspect-test", version: "0.0.0" });
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "pairmesh_ask_peer",
          arguments: {
            peer: "kelvin-agent",
            question: "What fields does the successful payment response contain?"
          }
        });

        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          completed: boolean;
          threadId: string;
          peer: string;
          summary?: string;
          findings?: string[];
          references?: Array<{ file: string; symbol?: string }>;
        };
        expect(structured.completed).toBe(true);
        expect(structured.threadId).toMatch(/^thr_/);
        expect(structured.peer).toBe("kelvin-agent");
        const combined =
          `${structured.summary} ${(structured.findings ?? []).join(" ")}`.toLowerCase();
        expect(combined).toContain("customerid");
        expect(combined).toContain("paymentreference");
        expect(structured.references).toEqual([
          expect.objectContaining({
            file: "src/payment.ts",
            symbol: "buildSuccessfulPaymentResponse"
          })
        ]);
        expect(JSON.stringify(structured)).not.toMatch(/\/Users\/|PAIRMESH_WORKSPACE|\.env/);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
      process.env.PAIRMESH_WORKSPACE = previousWorkspace;
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 35_000);
});
