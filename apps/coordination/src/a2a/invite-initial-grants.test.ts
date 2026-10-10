import { LocalStateStore, SessionManager } from "@pairmesh/client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "./index.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

function pickPort(): number {
  return 46_000 + Math.floor(Math.random() * 2_000);
}

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

describe("Invite-time Stage 10 policies", () => {
  it("applies inviter initialGrants on redeem and ignores join-side escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pairmesh-invite-grants-"));
    const paulStatePath = join(root, "paul", "state.json");
    const kelvinStatePath = join(root, "kelvin", "state.json");

    process.env.PAIRMESH_STATE_FILE = paulStatePath;
    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    process.env.PAIRMESH_WORKSPACE = fixtureWorkspace;
    process.env.PAIRMESH_FAKE_AGENT_DELAY_MS = "0";

    const paulPort = pickPort();
    let kelvinPort = pickPort();
    while (kelvinPort === paulPort) {
      kelvinPort = pickPort();
    }

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

    try {
      const paul = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: paulStatePath }),
        skipPeerHealthPreflight: true
      });
      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl,
        initialGrants: [
          { capabilityId: "repository.inspect", policy: "approval_required" },
          { capabilityId: "repository.source_references", policy: "deny" }
        ]
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

      const paulRows = await paul.listPeerPermissions("kelvin-agent");
      expect(paulRows[0]?.grants.map((g) => [g.capabilityId, g.policy])).toEqual([
        ["repository.inspect", "approval_required"],
        ["repository.source_references", "deny"],
        ["change.propose", "deny"],
        ["repository.edit", "deny"],
        ["tests.run", "deny"],
        ["process.execute", "deny"]
      ]);

      // Joiner's grants toward creator remain registry defaults (not invite template).
      const kelvinRows = await kelvin.listPeerPermissions("paul-agent");
      expect(kelvinRows[0]?.grants.map((g) => [g.capabilityId, g.policy])).toEqual([
        ["repository.inspect", "allow_session"],
        ["repository.source_references", "allow_session"],
        ["change.propose", "deny"],
        ["repository.edit", "deny"],
        ["tests.run", "deny"],
        ["process.execute", "deny"]
      ]);

      const ask = await kelvin.askPeer(
        "paul-agent",
        "What fields does the successful payment response contain?"
      );
      expect(ask.completed).toBe(false);
      if (!ask.completed) {
        expect(ask.status).toBe("approval_required");
      }
    } finally {
      await Promise.all([paulAgent.close(), kelvinAgent.close()]);
    }
  });
});
