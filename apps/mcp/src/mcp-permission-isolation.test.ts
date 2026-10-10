import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { findExecutionRecord } from "@pairmesh/client";

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

describe("Stage 14 permission isolation (multi-peer)", () => {
  it("Kelvin allow_session proceeds while Sarah approval_required blocks until approve; grants stay isolated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-perm-isolation-"));
    const creatorPath = join(dir, "creator.json");
    const kelvinPath = join(dir, "kelvin.json");
    const sarahPath = join(dir, "sarah.json");
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;
    const previousProvider = process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    const previousWorkspace = process.env.PAIRMESH_WORKSPACE;

    process.env.PAIRMESH_STATE_FILE = creatorPath;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;

    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 14711
    });
    process.env.PAIRMESH_STATE_FILE = kelvinPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 14712
    });
    process.env.PAIRMESH_STATE_FILE = sarahPath;
    const sarahAgent = createPairMeshA2AAgent({
      name: "sarah-agent",
      host: "127.0.0.1",
      port: 14713
    });
    process.env.PAIRMESH_STATE_FILE = creatorPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl),
        waitUntilReachable(sarahAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: creatorPath }),
        skipPeerHealthPreflight: true,
        inspectionTiming: {
          interactiveWaitMs: 800,
          mcpWaitForInspectionMs: 2_000,
          mcpMaxWaitMs: 4_000,
          duplicateQuestionWindowMs: 45_000,
          pollIntervalMs: 50,
          maxDurationMs: 120_000
        }
      });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });

      process.env.PAIRMESH_STATE_FILE = kelvinPath;
      const kelvin = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: kelvinPath })
      });
      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      const sarahInvite = await paul.createSessionInvite();
      process.env.PAIRMESH_STATE_FILE = sarahPath;
      const sarah = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: sarahPath })
      });
      await sarah.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: sarahInvite.inviteSecret,
        name: "sarah-agent",
        agentUrl: sarahAgent.baseUrl
      });

      // Receiver-side grants for Paul's participant (pairwise isolation).
      await kelvin.setPeerCapability("paul-agent", "repository.inspect", "allow_session");
      await sarah.setPeerCapability("paul-agent", "repository.inspect", "approval_required");

      const kelvinPermsBefore = await kelvin.listPeerPermissions("paul-agent");
      const sarahPermsBefore = await sarah.listPeerPermissions("paul-agent");
      expect(
        kelvinPermsBefore[0]?.grants.find((g) => g.capabilityId === "repository.inspect")?.policy
      ).toBe("allow_session");
      expect(
        sarahPermsBefore[0]?.grants.find((g) => g.capabilityId === "repository.inspect")?.policy
      ).toBe("approval_required");

      process.env.PAIRMESH_STATE_FILE = creatorPath;
      const kelvinQuestion = "Permission isolation kelvin question A";
      const sarahQuestion = "Permission isolation sarah question B";

      const [kelvinResult, sarahResult] = await Promise.all([
        paul.askPeer("kelvin-agent", kelvinQuestion),
        paul.askPeer("sarah-agent", sarahQuestion)
      ]);

      expect(kelvinResult.requestId).not.toBe(sarahResult.requestId);
      expect(kelvinResult.status).not.toBe("approval_required");
      expect(sarahResult.status).toBe("approval_required");
      expect(sarahResult.permissionRequestId).toBeTruthy();

      const paulStore = new LocalStateStore({ stateFilePath: creatorPath });
      const sarahExec = findExecutionRecord(await paulStore.load()!, sarahResult.requestId);
      expect(sarahExec?.a2aTaskReference?.a2aTaskId).toBeFalsy();
      expect(sarahExec?.executionStartedAt).toBeFalsy();

      process.env.PAIRMESH_STATE_FILE = sarahPath;
      const pending = await sarah.listPendingPermissions();
      expect(pending.some((p) => p.permissionRequestId === sarahResult.permissionRequestId)).toBe(
        true
      );
      await sarah.decidePendingPermission(sarahResult.permissionRequestId!, "allow-session");

      process.env.PAIRMESH_STATE_FILE = creatorPath;
      const sarahResumed = await paul.askPeer("sarah-agent", sarahQuestion);
      expect(sarahResumed.requestId).toBe(sarahResult.requestId);
      expect(sarahResumed.completed).toBe(true);

      process.env.PAIRMESH_STATE_FILE = kelvinPath;
      const kelvinPermsAfter = await kelvin.listPeerPermissions("paul-agent");
      expect(
        kelvinPermsAfter[0]?.grants.find((g) => g.capabilityId === "repository.inspect")?.policy
      ).toBe("allow_session");

      process.env.PAIRMESH_STATE_FILE = sarahPath;
      const sarahPermsAfter = await sarah.listPeerPermissions("paul-agent");
      expect(
        sarahPermsAfter[0]?.grants.find((g) => g.capabilityId === "repository.inspect")?.policy
      ).toBe("allow_session");
    } finally {
      await Promise.allSettled([paulAgent.close(), kelvinAgent.close(), sarahAgent.close()]);
      if (previousStateFile === undefined) {
        delete process.env.PAIRMESH_STATE_FILE;
      } else {
        process.env.PAIRMESH_STATE_FILE = previousStateFile;
      }
      if (previousProvider === undefined) {
        delete process.env.PAIRMESH_CODING_AGENT_PROVIDER;
      } else {
        process.env.PAIRMESH_CODING_AGENT_PROVIDER = previousProvider;
      }
      if (previousWorkspace === undefined) {
        delete process.env.PAIRMESH_WORKSPACE;
      } else {
        process.env.PAIRMESH_WORKSPACE = previousWorkspace;
      }
    }
  }, 60_000);
});
