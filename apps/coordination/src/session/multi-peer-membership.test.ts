import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalStateStore,
  SessionManager,
  isPairedWithLocal,
  requireOutboundBearer
} from "@pairmesh/client";
import { describe, expect, it } from "vitest";
import { createPairMeshA2AAgent } from "../a2a/index.js";

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

describe("Stage 14 multi-peer membership vs trust", () => {
  it("Sarah joining via Paul does not authenticate Sarah to Kelvin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-three-peer-"));
    const paulPath = join(dir, "paul.json");
    const kelvinPath = join(dir, "kelvin.json");
    const sarahPath = join(dir, "sarah.json");
    const previousStateFile = process.env.PAIRMESH_STATE_FILE;

    process.env.PAIRMESH_STATE_FILE = paulPath;
    const paulAgent = createPairMeshA2AAgent({
      name: "paul-agent",
      host: "127.0.0.1",
      port: 4481
    });
    process.env.PAIRMESH_STATE_FILE = kelvinPath;
    const kelvinAgent = createPairMeshA2AAgent({
      name: "kelvin-agent",
      host: "127.0.0.1",
      port: 4482
    });
    process.env.PAIRMESH_STATE_FILE = sarahPath;
    const sarahAgent = createPairMeshA2AAgent({
      name: "sarah-agent",
      host: "127.0.0.1",
      port: 4483
    });
    process.env.PAIRMESH_STATE_FILE = paulPath;

    try {
      await Promise.all([
        waitUntilReachable(paulAgent.agentCardUrl),
        waitUntilReachable(kelvinAgent.agentCardUrl),
        waitUntilReachable(sarahAgent.agentCardUrl)
      ]);

      const paul = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: paulPath })
      });
      const kelvin = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: kelvinPath })
      });
      const sarah = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: sarahPath })
      });

      const created = await paul.createSession({
        name: "paul-agent",
        agentUrl: paulAgent.baseUrl
      });
      await kelvin.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: created.invite.inviteSecret,
        name: "kelvin-agent",
        agentUrl: kelvinAgent.baseUrl
      });

      const sarahInvite = await paul.createSessionInvite({
        initialGrants: [
          { capabilityId: "repository.inspect", policy: "allow_session" },
          { capabilityId: "repository.source_references", policy: "deny" }
        ]
      });
      // Kelvin's open invite count is independent — Paul still has Kelvin paired.
      expect((await paul.getSessionStatus()).peers).toHaveLength(1);

      await sarah.joinSession({
        sessionCode: created.sessionCode,
        peerUrl: paulAgent.baseUrl,
        inviteSecret: sarahInvite.inviteSecret,
        name: "sarah-agent",
        agentUrl: sarahAgent.baseUrl
      });

      const paulStatus = await paul.getSessionStatus();
      const sarahStatus = await sarah.getSessionStatus();
      const kelvinStatus = await kelvin.getSessionStatus();

      expect(paulStatus.peers).toHaveLength(2);
      expect(paulStatus.peers.every((peer) => isPairedWithLocal(peer))).toBe(true);

      const paulOnSarah = sarahStatus.peers.find((peer) => peer.agent.name === "paul-agent");
      const kelvinOnSarah = sarahStatus.peers.find((peer) => peer.agent.name === "kelvin-agent");
      expect(paulOnSarah && isPairedWithLocal(paulOnSarah)).toBe(true);
      expect(kelvinOnSarah).toBeDefined();
      expect(kelvinOnSarah && isPairedWithLocal(kelvinOnSarah)).toBe(false);

      // Critical: no Sarah↔Kelvin trust on Kelvin either (membership not gossiped).
      expect(kelvinStatus.peers).toHaveLength(1);
      expect(kelvinStatus.peers[0]?.agent.name).toBe("paul-agent");

      if (!kelvinOnSarah) {
        throw new Error("expected Kelvin membership on Sarah without pairing");
      }
      const sarahState = await new LocalStateStore({ stateFilePath: sarahPath }).load();
      if (!sarahState) {
        throw new Error("expected sarah state");
      }
      expect(() => requireOutboundBearer(sarahState, kelvinOnSarah)).toThrow(
        /authentication_required|No session credential/
      );

      await expect(
        sarah.askPeer("kelvin-agent", "Should not reach Kelvin coding agent")
      ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });

      // Pair-later: Kelvin invites Sarah; Sarah redeems without leaving collaboration.
      const kelvinInvite = await kelvin.createSessionInvite();
      await sarah.establishRelationship({
        peerUrl: kelvinAgent.baseUrl,
        inviteSecret: kelvinInvite.inviteSecret
      });

      const sarahAfterPair = await sarah.getSessionStatus();
      const kelvinAfterPair = await kelvin.getSessionStatus();
      const kelvinPeer = sarahAfterPair.peers.find((peer) => peer.agent.name === "kelvin-agent");
      expect(kelvinPeer && isPairedWithLocal(kelvinPeer)).toBe(true);
      expect(kelvinAfterPair.peers.some((peer) => peer.agent.name === "sarah-agent")).toBe(true);

      // Paul↔Kelvin and Paul↔Sarah remain.
      expect((await paul.getSessionStatus()).peers).toHaveLength(2);
      expect((await paul.getSessionStatus()).peers.every((peer) => isPairedWithLocal(peer))).toBe(
        true
      );
    } finally {
      process.env.PAIRMESH_STATE_FILE = previousStateFile;
      await Promise.all([paulAgent.close(), kelvinAgent.close(), sarahAgent.close()]);
    }
  }, 45_000);
});
