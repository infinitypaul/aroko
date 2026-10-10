import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PeerIdSchema } from "@pairmesh/protocol";
import { getGrantPolicy } from "../auth/capabilities.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "../session/manager.js";

/**
 * Prompt 7 regression: CLI/Control `setPeerCapability` must accept Stage 15
 * action capabilities (ADR 0043), not only Stage 10 inspect caps.
 */
describe("Stage 15 Prompt 7 — grantable action capabilities via setPeerCapability", () => {
  it("grants change.propose / repository.edit / tests.run and rejects future caps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-p7-grant-"));
    const stateFilePath = join(dir, "state.json");
    const stateStore = new LocalStateStore({ stateFilePath });
    const manager = new SessionManager({ stateStore });
    await manager.createSession({
      name: "kelvin-agent",
      agentUrl: "http://127.0.0.1:6401/"
    });

    const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
    const state = (await stateStore.load())!;
    state.peers = [
      {
        participant: {
          id: paulId,
          sessionId: state.session.id,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          joinedAt: state.session.createdAt
        },
        agent: {
          id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          projectId: state.localParticipant.agent.projectId,
          name: "paul-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: { id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01", displayName: "Paul" },
        a2aAgentUrl: "http://127.0.0.1:6402/",
        isLocal: false
      }
    ];
    await stateStore.save(state);

    await manager.setPeerCapability("paul-agent", "change.propose", "allow_session");
    await manager.setPeerCapability("paul-agent", "repository.edit", "approval_required");
    await manager.setPeerCapability("paul-agent", "tests.run", "allow_session");
    await manager.setPeerCapability("paul-agent", "process.execute", "approval_required");

    const after = (await stateStore.load())!;
    expect(getGrantPolicy(after, paulId, "change.propose")).toBe("allow_session");
    expect(getGrantPolicy(after, paulId, "repository.edit")).toBe("approval_required");
    expect(getGrantPolicy(after, paulId, "tests.run")).toBe("allow_session");
    expect(getGrantPolicy(after, paulId, "process.execute")).toBe("approval_required");

    await expect(
      manager.setPeerCapability("paul-agent", "repository.edit", "allow_session")
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });

    await expect(
      manager.setPeerCapability("paul-agent", "process.execute", "allow_session")
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });

    await expect(
      manager.setPeerCapability("paul-agent", "shell.execute", "allow_session")
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });

    await expect(
      manager.setPeerCapability("paul-agent", "repository.shell", "allow_session")
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });
  });
});
