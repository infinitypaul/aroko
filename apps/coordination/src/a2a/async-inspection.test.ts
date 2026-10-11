import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "./index.js";
import { allocateEphemeralPortPair } from "./test-ports.js";

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

async function createPairedManagers(options?: {
  kelvinDelayMs?: number;
  interactiveWaitMs?: number;
  maxDurationMs?: number;
  pollIntervalMs?: number;
}) {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-async-"));
  const creatorPath = join(dir, "creator.json");
  const joinerPath = join(dir, "joiner.json");

  process.env.PAIRMESH_STATE_FILE = creatorPath;
  process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
  process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
  process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = String(options?.kelvinDelayMs ?? 0);

  // Ephemeral OS ports — avoids collisions with parallel A2A/MCP suites that
  // previously shared the random 46000–48000 band (CI EADDRINUSE on 47238).
  const { a: paulPort, b: kelvinPort } = await allocateEphemeralPortPair();

  // Each agent binds the state file that is current when it is created, so the
  // joiner's agent must be created against the joiner's state.
  const paulAgent = createPairMeshA2AAgent({
    name: "paul-agent",
    host: "127.0.0.1",
    port: paulPort
  });
  process.env.PAIRMESH_STATE_FILE = joinerPath;
  const kelvinAgent = createPairMeshA2AAgent({
    name: "kelvin-agent",
    host: "127.0.0.1",
    port: kelvinPort,
    fakeAgentDelayMs: options?.kelvinDelayMs ?? 0
  });
  process.env.PAIRMESH_STATE_FILE = creatorPath;

  await Promise.all([
    waitUntilReachable(paulAgent.agentCardUrl),
    waitUntilReachable(kelvinAgent.agentCardUrl)
  ]);

  const paul = new SessionManager({
    stateStore: new LocalStateStore({ stateFilePath: creatorPath }),
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

  return { paul, kelvinAgent, paulAgent };
}

describe("async inspection execution", () => {
  it("returns a completed answer on the fast path", async () => {
    const { paul, kelvinAgent, paulAgent } = await createPairedManagers({
      kelvinDelayMs: 0,
      interactiveWaitMs: 5_000
    });

    try {
      const result = await paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(result.completed).toBe(true);
      if (result.completed) {
        expect(result.summary.toLowerCase()).toContain("customerid");
      }
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 20_000);

  it("returns a working handle when interactive wait expires before remote completion", async () => {
    const { paul, kelvinAgent, paulAgent } = await createPairedManagers({
      kelvinDelayMs: 3_000,
      interactiveWaitMs: 200,
      pollIntervalMs: 50
    });

    try {
      const initial = await paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(initial.completed).toBe(false);
      if (!initial.completed) {
        expect(initial.status).toBe("working");
      }

      const finished = await paul.waitForInspection(initial.requestId, { waitMs: 10_000 });
      expect(finished.completed).toBe(true);
      if (finished.completed) {
        expect(finished.result).toBeDefined();
      }
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 20_000);

  it("keeps execution running after local wait expiry (not timed_out)", async () => {
    const { paul, kelvinAgent, paulAgent } = await createPairedManagers({
      kelvinDelayMs: 3_000,
      interactiveWaitMs: 150,
      pollIntervalMs: 50
    });

    try {
      const initial = await paul.askPeer("kelvin-agent", "Where is paymentReference mapped?");
      expect(initial.completed).toBe(false);

      const status = await paul.getInspectionStatus(initial.requestId);
      expect(status.status).toBe("working");
      expect(status.status).not.toBe("timed_out");
      expect(status.localWait).toBe("expired");
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 20_000);

  it("marks terminal timed_out only when remote hard deadline is exceeded", async () => {
    const { paul, kelvinAgent, paulAgent } = await createPairedManagers({
      kelvinDelayMs: 3_000,
      interactiveWaitMs: 100,
      maxDurationMs: 300,
      pollIntervalMs: 50
    });

    try {
      const initial = await paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(initial.completed).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await paul.getInspectionStatus(initial.requestId);
      expect(status.status).toBe("timed_out");
      expect(status.error).toMatchObject({ code: "pairmesh.inspection_timeout" });
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 15_000);

  it("returns cached results idempotently from inspection status", async () => {
    const { paul, kelvinAgent, paulAgent } = await createPairedManagers({
      kelvinDelayMs: 0,
      interactiveWaitMs: 5_000
    });

    try {
      const initial = await paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(initial.completed).toBe(true);

      const first = await paul.getInspectionStatus(initial.requestId);
      const second = await paul.getInspectionStatus(initial.requestId);
      expect(first.result).toEqual(second.result);
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 20_000);

  it("cancels an in-flight inspection", async () => {
    const { paul, kelvinAgent, paulAgent } = await createPairedManagers({
      kelvinDelayMs: 5_000,
      interactiveWaitMs: 100,
      maxDurationMs: 120_000,
      pollIntervalMs: 50
    });

    try {
      const initial = await paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(initial.completed).toBe(false);

      await paul.cancelInspection(initial.requestId);
      const status = await paul.getInspectionStatus(initial.requestId);
      expect(status.status).toBe("cancelled");
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  }, 15_000);
});
