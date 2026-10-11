import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function createPairedManagers() {
  const root = await mkdtemp(join(tmpdir(), "pairmesh-capability-"));
  const paulStatePath = join(root, "paul", "state.json");
  const kelvinStatePath = join(root, "kelvin", "state.json");

  process.env.PAIRMESH_STATE_FILE = paulStatePath;
  process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
  process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
  process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = "0";

  const { a: paulPort, b: kelvinPort } = await allocateEphemeralPortPair();

  const paulAgent = createPairMeshA2AAgent({
    name: "paul-agent",
    host: "127.0.0.1",
    port: paulPort,
    fakeAgentDelayMs: 0
  });
  process.env.PAIRMESH_STATE_FILE = kelvinStatePath;
  const kelvinAgent = createPairMeshA2AAgent({
    name: "kelvin-agent",
    host: "127.0.0.1",
    port: kelvinPort,
    fakeAgentDelayMs: 0
  });
  process.env.PAIRMESH_STATE_FILE = paulStatePath;

  await Promise.all([
    waitUntilReachable(paulAgent.agentCardUrl),
    waitUntilReachable(kelvinAgent.agentCardUrl)
  ]);

  const paulStateStore = new LocalStateStore({ stateFilePath: paulStatePath });
  const paul = new SessionManager({
    stateStore: paulStateStore,
    skipPeerHealthPreflight: true,
    inspectionTiming: {
      interactiveWaitMs: 15_000,
      mcpWaitForInspectionMs: 4_000,
      mcpMaxWaitMs: 8_000,
      duplicateQuestionWindowMs: 45_000,
      maxDurationMs: 60_000,
      pollIntervalMs: 200
    }
  });

  const created = await paul.createSession({
    name: "paul-agent",
    agentUrl: paulAgent.baseUrl
  });

  process.env.PAIRMESH_STATE_FILE = kelvinStatePath;
  const kelvinStateStore = new LocalStateStore({ stateFilePath: kelvinStatePath });
  const kelvin = new SessionManager({
    stateStore: kelvinStateStore,
    skipPeerHealthPreflight: true,
    inspectionTiming: {
      interactiveWaitMs: 15_000,
      mcpWaitForInspectionMs: 4_000,
      mcpMaxWaitMs: 8_000,
      duplicateQuestionWindowMs: 45_000,
      maxDurationMs: 60_000,
      pollIntervalMs: 200
    }
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
    paulStatePath,
    paulStateStore,
    kelvinStatePath,
    close: async () => {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  };
}

describe("Stage 10 capability authorization", () => {
  it("defaults allow inspect + references for a newly paired peer", async () => {
    const ctx = await createPairedManagers();
    try {
      const rows = await ctx.kelvin.listPeerPermissions("paul-agent");
      expect(rows[0]?.grants.map((g) => [g.capabilityId, g.policy])).toEqual([
        ["repository.inspect", "allow_session"],
        ["repository.source_references", "allow_session"],
        ["change.propose", "deny"],
        ["repository.edit", "deny"],
        ["tests.run", "deny"],
        ["process.execute", "deny"]
      ]);

      const result = await ctx.paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(result.completed).toBe(true);
      if (result.completed) {
        expect(result.summary.length).toBeGreaterThan(0);
        expect(result.references.length).toBeGreaterThan(0);
      }
    } finally {
      await ctx.close();
    }
  });

  it("strips references when source_references is denied without re-pairing", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.source_references", "deny");

      const result = await ctx.paul.askPeer(
        "kelvin-agent",
        "What fields does the successful payment response contain?"
      );
      expect(result.completed).toBe(true);
      if (result.completed) {
        expect(result.summary.length).toBeGreaterThan(0);
        expect(result.references).toEqual([]);
      }

      await ctx.kelvin.setPeerCapability(
        "paul-agent",
        "repository.source_references",
        "allow_session"
      );
      const restored = await ctx.paul.askPeer(
        "kelvin-agent",
        "How does a webhook eventually produce the successful payment response?"
      );
      expect(restored.completed).toBe(true);
      if (restored.completed) {
        expect(restored.references.length).toBeGreaterThan(0);
      }
    } finally {
      await ctx.close();
    }
  });

  it("denies inspect and supports approval once/session", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "deny");
      await expect(
        ctx.paul.askPeer("kelvin-agent", "Where is rebuildPaymentFromRetryRecord defined?")
      ).rejects.toMatchObject({ code: "pairmesh.capability_denied" });

      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "approval_required");

      const pendingAsk = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where is rebuildPaymentFromRetryRecord defined?"
      );
      expect(pendingAsk.completed).toBe(false);
      if (!pendingAsk.completed) {
        expect(pendingAsk.status).toBe("approval_required");
      }

      const pending = await ctx.kelvin.listPendingPermissions();
      expect(pending).toHaveLength(1);

      await ctx.kelvin.decidePendingPermission(pending[0]!.permissionRequestId, "allow-once");
      const once = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where is rebuildPaymentFromRetryRecord defined?"
      );
      expect(once.completed).toBe(true);

      const again = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where does webhook signature verification live?"
      );
      expect(again.completed).toBe(false);
      if (!again.completed) {
        expect(again.status).toBe("approval_required");
      }

      const pending2 = await ctx.kelvin.listPendingPermissions();
      await ctx.kelvin.decidePendingPermission(pending2[0]!.permissionRequestId, "allow-session");
      const sessionOk = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where does webhook signature verification live?"
      );
      expect(sessionOk.completed).toBe(true);

      const follow = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where is rebuildPaymentFromRetryRecord defined again?"
      );
      expect(follow.completed).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("deny on pending permission blocks the request", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "approval_required");
      const pendingAsk = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where is rebuildPaymentFromRetryRecord defined?"
      );
      expect(pendingAsk.completed).toBe(false);
      const pending = await ctx.kelvin.listPendingPermissions();
      await ctx.kelvin.decidePendingPermission(pending[0]!.permissionRequestId, "deny");
      await expect(
        ctx.paul.askPeer("kelvin-agent", "Where is rebuildPaymentFromRetryRecord defined?")
      ).rejects.toMatchObject({ code: "pairmesh.capability_denied" });
    } finally {
      await ctx.close();
    }
  });

  it("resumes the same requestId after approval waits beyond the 45s duplicate window", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "approval_required");
      const question = "Where is rebuildPaymentFromRetryRecord defined for late approval?";
      const pendingAsk = await ctx.paul.askPeer("kelvin-agent", question);
      expect(pendingAsk.completed).toBe(false);
      if (pendingAsk.completed || pendingAsk.status !== "approval_required") {
        throw new Error("expected approval_required");
      }
      const originalRequestId = pendingAsk.requestId;

      const paulState = await ctx.paulStateStore.load();
      if (!paulState) {
        throw new Error("missing paul state");
      }
      const execution = paulState.inspectionExecutions.find(
        (entry) => entry.requestId === originalRequestId
      );
      if (!execution) {
        throw new Error("missing execution");
      }
      const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();
      execution.startedAt = sixtySecondsAgo;
      execution.updatedAt = sixtySecondsAgo;
      await ctx.paulStateStore.save(paulState);

      const pending = await ctx.kelvin.listPendingPermissions();
      await ctx.kelvin.decidePendingPermission(pending[0]!.permissionRequestId, "allow-once");

      const resumed = await ctx.paul.askPeer("kelvin-agent", question);
      expect(resumed.completed).toBe(true);
      if (resumed.completed) {
        expect(resumed.requestId).toBe(originalRequestId);
      }

      const again = await ctx.paul.askPeer(
        "kelvin-agent",
        "Where does webhook signature verification live after once?"
      );
      expect(again.completed).toBe(false);
      if (!again.completed) {
        expect(again.status).toBe("approval_required");
      }
    } finally {
      await ctx.close();
    }
  });

  it("permission waiting does not consume the ACP execution deadline budget", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "approval_required");
      const question = "Where is rebuildPaymentFromRetryRecord defined for deadline budget?";
      const pendingAsk = await ctx.paul.askPeer("kelvin-agent", question);
      expect(pendingAsk.completed).toBe(false);
      if (pendingAsk.completed || pendingAsk.status !== "approval_required") {
        throw new Error("expected approval_required");
      }

      const paulState = await ctx.paulStateStore.load();
      const execution = paulState?.inspectionExecutions.find(
        (entry) => entry.requestId === pendingAsk.requestId
      );
      if (!execution || !paulState) {
        throw new Error("missing execution");
      }
      // Simulate a long human approval wait that would exhaust a 60s startedAt clock.
      execution.startedAt = new Date(Date.now() - 55_000).toISOString();
      execution.updatedAt = execution.startedAt;
      delete execution.executionStartedAt;
      await ctx.paulStateStore.save(paulState);

      const pending = await ctx.kelvin.listPendingPermissions();
      await ctx.kelvin.decidePendingPermission(pending[0]!.permissionRequestId, "allow-once");

      const resumed = await ctx.paul.askPeer("kelvin-agent", question);
      expect(resumed.completed).toBe(true);
      if (resumed.completed) {
        expect(resumed.requestId).toBe(pendingAsk.requestId);
      }

      const after = await ctx.paulStateStore.load();
      const finished = after?.inspectionExecutions.find(
        (entry) => entry.requestId === pendingAsk.requestId
      );
      expect(finished?.executionStartedAt).toBeTruthy();
      expect(Date.parse(finished!.executionStartedAt!)).toBeGreaterThan(
        Date.parse(finished!.startedAt)
      );
    } finally {
      await ctx.close();
    }
  });

  it("does not duplicate permission.requested on repeated asks while pending", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "approval_required");
      const question = "Where is rebuildPaymentFromRetryRecord defined for audit idempotency?";
      await ctx.paul.askPeer("kelvin-agent", question);
      await ctx.paul.askPeer("kelvin-agent", question);
      await ctx.paul.askPeer("kelvin-agent", question);

      await ctx.kelvin.flushAudit();
      const events = await ctx.kelvin.listAuditEvents(50);
      const requested = events.filter((event) => event.eventType === "permission.requested");
      expect(requested).toHaveLength(1);

      const pending = await ctx.kelvin.listPendingPermissions();
      await ctx.kelvin.decidePendingPermission(pending[0]!.permissionRequestId, "deny");
      await expect(ctx.paul.askPeer("kelvin-agent", question)).rejects.toMatchObject({
        code: "pairmesh.capability_denied"
      });

      await ctx.kelvin.flushAudit();
      const afterDeny = await ctx.kelvin.listAuditEvents(50);
      const denied = afterDeny.filter((event) => event.eventType === "permission.denied");
      expect(denied).toHaveLength(1);

      // Same question after terminal deny starts a new request (needs fresh approval).
      const next = await ctx.paul.askPeer("kelvin-agent", question);
      expect(next.completed).toBe(false);
      if (!next.completed) {
        expect(next.status).toBe("approval_required");
      }

      await ctx.kelvin.flushAudit();
      const afterNext = await ctx.kelvin.listAuditEvents(50);
      expect(afterNext.filter((event) => event.eventType === "permission.denied")).toHaveLength(1);
      expect(afterNext.filter((event) => event.eventType === "permission.requested")).toHaveLength(
        2
      );
    } finally {
      await ctx.close();
    }
  });

  it("repeated approval resume does not execute ACP twice for allow-once", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.kelvin.setPeerCapability("paul-agent", "repository.inspect", "approval_required");
      const question = "Where is rebuildPaymentFromRetryRecord defined for double resume?";
      const pendingAsk = await ctx.paul.askPeer("kelvin-agent", question);
      if (pendingAsk.completed || pendingAsk.status !== "approval_required") {
        throw new Error("expected approval_required");
      }
      const pending = await ctx.kelvin.listPendingPermissions();
      await ctx.kelvin.decidePendingPermission(pending[0]!.permissionRequestId, "allow-once");

      const first = await ctx.paul.askPeer("kelvin-agent", question);
      expect(first.completed).toBe(true);
      const second = await ctx.paul.askPeer("kelvin-agent", question);
      expect(second.completed).toBe(true);
      if (first.completed && second.completed) {
        expect(second.requestId).toBe(first.requestId);
      }

      await ctx.kelvin.flushAudit();
      const events = await ctx.kelvin.listAuditEvents(50);
      const started = events.filter((event) => event.eventType === "inspection.started");
      expect(started).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it("peer remove invalidates capability grants", async () => {
    const ctx = await createPairedManagers();
    try {
      await ctx.paul.removePeer("kelvin-agent");
      const state = await new LocalStateStore({ stateFilePath: ctx.paulStatePath }).load();
      expect(state?.sessionSecurity?.capabilityGrants ?? []).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
