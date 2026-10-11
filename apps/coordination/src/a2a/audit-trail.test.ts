import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStateStore, SessionManager, formatAuditEventHuman } from "@pairmesh/client";
import { describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "./index.js";
import { allocateEphemeralPortPair } from "./test-ports.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");
const QUESTION_CANARY = "PAIR_MESH_PRIVATE_QUESTION_DO_NOT_LOG";


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

async function createPairedManagers(options?: {
  kelvinDelayMs?: number;
  interactiveWaitMs?: number;
  maxDurationMs?: number;
  pollIntervalMs?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "pairmesh-audit-trail-"));
  // Separate state parents so each peer gets its own `.pairmesh`-style audit dir.
  const paulStatePath = join(root, "paul", "state.json");
  const kelvinStatePath = join(root, "kelvin", "state.json");

  process.env.PAIRMESH_STATE_FILE = paulStatePath;
  process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
  process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
  process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = String(options?.kelvinDelayMs ?? 0);

  const { a: paulPort, b: kelvinPort } = await allocateEphemeralPortPair();

  const paulAgent = createPairMeshA2AAgent({
    name: "paul-agent",
    host: "127.0.0.1",
    port: paulPort
  });
  process.env.PAIRMESH_STATE_FILE = kelvinStatePath;
  const kelvinAgent = createPairMeshA2AAgent({
    name: "kelvin-agent",
    host: "127.0.0.1",
    port: kelvinPort,
    fakeAgentDelayMs: options?.kelvinDelayMs ?? 0
  });
  process.env.PAIRMESH_STATE_FILE = paulStatePath;

  await Promise.all([
    waitUntilReachable(paulAgent.agentCardUrl),
    waitUntilReachable(kelvinAgent.agentCardUrl)
  ]);

  const paul = new SessionManager({
    stateStore: new LocalStateStore({ stateFilePath: paulStatePath }),
    skipPeerHealthPreflight: true,
    inspectionTiming: {
      interactiveWaitMs: options?.interactiveWaitMs ?? 15_000,
      mcpWaitForInspectionMs: 4_000,
      mcpMaxWaitMs: 8_000,
      duplicateQuestionWindowMs: 45_000,
      maxDurationMs: options?.maxDurationMs ?? 120_000,
      pollIntervalMs: options?.pollIntervalMs ?? 100
    }
  });

  const created = await paul.createSession({
    name: "paul-agent",
    agentUrl: paulAgent.baseUrl
  });

  process.env.PAIRMESH_STATE_FILE = kelvinStatePath;
  const kelvin = new SessionManager({
    stateStore: new LocalStateStore({ stateFilePath: kelvinStatePath }),
    skipPeerHealthPreflight: true
  });
  await kelvin.joinSession({
    sessionCode: created.sessionCode,
    peerUrl: paulAgent.baseUrl,
    inviteSecret: created.invite.inviteSecret,
    name: "kelvin-agent",
    agentUrl: kelvinAgent.baseUrl
  });

  process.env.PAIRMESH_STATE_FILE = paulStatePath;

  return {
    paul,
    kelvin,
    paulAgent,
    kelvinAgent,
    paulStatePath,
    kelvinStatePath,
    inviteSecret: created.invite.inviteSecret
  };
}

function eventTypes(events: Array<{ eventType: string }>): string[] {
  return events.map((event) => event.eventType);
}

describe("local audit trail", () => {
  it("records join, inspection lifecycle, result metadata, and never stores the question", async () => {
    const ctx = await createPairedManagers({
      kelvinDelayMs: 0,
      interactiveWaitMs: 5_000
    });

    try {
      const result = await ctx.paul.askPeer(
        "kelvin-agent",
        `What fields does the successful payment response contain? ${QUESTION_CANARY}`
      );
      expect(result.completed).toBe(true);

      await ctx.paul.flushAudit();
      await ctx.kelvin.flushAudit();

      const paulEvents = await ctx.paul.listAuditEvents(50);
      const kelvinEvents = await ctx.kelvin.listAuditEvents(50);

      expect(eventTypes(paulEvents)).toEqual(
        expect.arrayContaining([
          "session.created",
          "invite.created",
          "invite.redeemed",
          "peer.joined",
          "inspection.requested",
          "inspection.completed",
          "inspection.result_shared"
        ])
      );
      expect(eventTypes(kelvinEvents)).toEqual(
        expect.arrayContaining([
          "peer.joined",
          "inspection.started",
          "inspection.completed",
          "inspection.result_shared"
        ])
      );

      const shared = paulEvents.find((event) => event.eventType === "inspection.result_shared");
      expect(shared?.metadata).toMatchObject({
        direction: "inbound",
        summaryPresent: true
      });
      if (shared?.eventType === "inspection.result_shared") {
        expect(shared.metadata.referenceCount).toBeGreaterThan(0);
        expect(shared.metadata.referencedFiles.every((file) => !file.startsWith("/"))).toBe(true);
      }

      const paulRaw = await readFile(
        join(ctx.paulStatePath, "..", "audit", "events.jsonl"),
        "utf8"
      );
      const kelvinRaw = await readFile(
        join(ctx.kelvinStatePath, "..", "audit", "events.jsonl"),
        "utf8"
      );
      for (const raw of [paulRaw, kelvinRaw]) {
        expect(raw).not.toContain(QUESTION_CANARY);
        expect(raw).not.toContain(ctx.inviteSecret);
        expect(raw).not.toContain("Authorization: Bearer");
        expect(raw).not.toMatch(/\/Users\/|\/home\/|fixtures\/payment-workspace/);
      }

      const human = formatAuditEventHuman(paulEvents[0]!);
      expect(human.length).toBeGreaterThan(10);
    } finally {
      await Promise.all([ctx.paulAgent.close(), ctx.kelvinAgent.close()]);
    }
  }, 30_000);

  it("records authentication.failed, peer.removed, and session.left without secrets", async () => {
    const ctx = await createPairedManagers({
      kelvinDelayMs: 0,
      interactiveWaitMs: 5_000
    });

    try {
      await ctx.paul.removePeer("kelvin-agent");
      await expect(ctx.kelvin.askPeer("paul-agent", QUESTION_CANARY)).rejects.toMatchObject({
        code: expect.stringMatching(/authentication|peer_revoked|authentication_required/)
      });

      await ctx.kelvin.flushAudit();
      await ctx.paul.flushAudit();

      const kelvinEvents = await ctx.kelvin.listAuditEvents(50);
      expect(eventTypes(kelvinEvents)).toEqual(
        expect.arrayContaining(["authentication.failed", "inspection.failed"])
      );

      const paulEvents = await ctx.paul.listAuditEvents(50);
      expect(eventTypes(paulEvents)).toContain("peer.removed");

      await ctx.paul.leaveSession();
      await ctx.paul.flushAudit();
      expect(eventTypes(await ctx.paul.listAuditEvents(50))).toContain("session.left");

      const reloaded = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: ctx.paulStatePath })
      });
      const preserved = await reloaded.listAuditEvents(50);
      expect(eventTypes(preserved)).toEqual(
        expect.arrayContaining(["session.created", "peer.removed", "session.left"])
      );

      const raw = await readFile(join(ctx.paulStatePath, "..", "audit", "events.jsonl"), "utf8");
      expect(raw).not.toContain(ctx.inviteSecret);
      expect(raw).not.toContain(QUESTION_CANARY);
    } finally {
      await Promise.all([ctx.paulAgent.close(), ctx.kelvinAgent.close()]);
    }
  }, 30_000);

  it("records cancelled and timed_out terminal audit events", async () => {
    const cancelCtx = await createPairedManagers({
      kelvinDelayMs: 5_000,
      interactiveWaitMs: 100,
      pollIntervalMs: 50
    });

    try {
      const initial = await cancelCtx.paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(initial.completed).toBe(false);
      await cancelCtx.paul.cancelInspection(initial.requestId);
      await cancelCtx.paul.flushAudit();
      expect(eventTypes(await cancelCtx.paul.listAuditEvents(50))).toContain(
        "inspection.cancelled"
      );
    } finally {
      await Promise.all([cancelCtx.paulAgent.close(), cancelCtx.kelvinAgent.close()]);
    }

    const timeoutCtx = await createPairedManagers({
      kelvinDelayMs: 3_000,
      interactiveWaitMs: 100,
      maxDurationMs: 300,
      pollIntervalMs: 50
    });

    try {
      const initial = await timeoutCtx.paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(initial.completed).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await timeoutCtx.paul.getInspectionStatus(initial.requestId);
      await timeoutCtx.paul.flushAudit();
      expect(eventTypes(await timeoutCtx.paul.listAuditEvents(50))).toContain(
        "inspection.timed_out"
      );
    } finally {
      await Promise.all([timeoutCtx.paulAgent.close(), timeoutCtx.kelvinAgent.close()]);
    }
  }, 40_000);
});
