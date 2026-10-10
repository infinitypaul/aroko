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

describe("inspection thread MCP integration", () => {
  it("supports multi-turn follow-up on the same thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-thread-"));
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
      port: 4551
    });
    // Each agent binds the state file current at creation time.
    process.env.PAIRMESH_STATE_FILE = joinerPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4552
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
          maxDurationMs: 120_000,
          pollIntervalMs: 100
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
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createPairMeshMcpServer(paul);
      await server.connect(serverTransport);
      const client = new Client({ name: "pairmesh-thread-test", version: "0.0.0" });
      await client.connect(clientTransport);

      try {
        const turn1 = await client.callTool({
          name: "pairmesh_ask_peer",
          arguments: {
            peer: "kelvin-agent",
            question: "What fields does the successful payment response contain?"
          }
        });
        expect(turn1.isError).not.toBe(true);
        const turn1Data = turn1.structuredContent as {
          completed?: boolean;
          threadId: string;
          requestId?: string;
          summary?: string;
          findings?: string[];
          references?: Array<{ file: string; symbol?: string }>;
        };
        expect(turn1Data.threadId).toMatch(/^thr_/);
        const combined1 =
          `${turn1Data.summary ?? ""} ${(turn1Data.findings ?? []).join(" ")}`.toLowerCase();
        expect(combined1).toContain("customerid");
        expect(combined1).toContain("paymentreference");
        expect(turn1Data.references ?? []).toEqual([
          expect.objectContaining({
            file: "src/payment.ts",
            symbol: "buildSuccessfulPaymentResponse"
          })
        ]);

        const turn2 = await client.callTool({
          name: "pairmesh_follow_up",
          arguments: {
            threadId: turn1Data.threadId,
            question: "Where does paymentReference come from?"
          }
        });
        expect(turn2.isError).not.toBe(true);
        const turn2Data = turn2.structuredContent as {
          threadId: string;
          summary: string;
          findings: string[];
          references: Array<{ file: string; symbol?: string }>;
        };
        expect(turn2Data.threadId).toBe(turn1Data.threadId);
        const combined2 = `${turn2Data.summary} ${turn2Data.findings.join(" ")}`.toLowerCase();
        expect(combined2).toContain("payment.reference");
        expect(turn2Data.references).toEqual([
          expect.objectContaining({
            file: "src/payment.ts",
            symbol: "buildSuccessfulPaymentResponse"
          })
        ]);

        const listed = await client.callTool({ name: "pairmesh_list_threads", arguments: {} });
        const threads = (
          listed.structuredContent as { threads: Array<{ id: string; turnCount: number }> }
        ).threads;
        expect(
          threads.some((thread) => thread.id === turn1Data.threadId && thread.turnCount === 2)
        ).toBe(true);
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
  }, 45_000);
});
