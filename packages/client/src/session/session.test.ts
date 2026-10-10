import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionManager, parseSessionCode } from "./manager.js";
import { LocalStateStore } from "../state/store.js";

function tempStore(): Promise<{ store: LocalStateStore; dir: string }> {
  return mkdtemp(join(tmpdir(), "pairmesh-session-")).then((dir) => ({
    dir,
    store: new LocalStateStore({ stateFilePath: join(dir, "state.json") })
  }));
}

describe("SessionManager create", () => {
  it("creates an active session with valid ids and local participant", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const status = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101/"
    });

    expect(status.sessionCode).toMatch(/^PM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(status.sessionId).toMatch(/^ses_[0-9a-f-]+$/);
    expect(status.status).toBe("active");
    expect(status.localParticipant.isLocal).toBe(true);
    expect(status.localParticipant.agent.name).toBe("paul-agent");
    expect(status.localParticipant.a2aAgentUrl).toBe("http://127.0.0.1:4101");
    expect(status.peers).toHaveLength(0);
  });
});

describe("SessionManager join/status/leave", () => {
  it("rejects duplicate create and clears on leave", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    await expect(
      manager.createSession({
        name: "other-agent",
        agentUrl: "http://127.0.0.1:4102"
      })
    ).rejects.toMatchObject({ code: "pairmesh.session_invalid_state" });

    await manager.leaveSession();

    await expect(manager.getSessionStatus()).rejects.toMatchObject({
      code: "pairmesh.session_not_found"
    });

    expect(parseSessionCode(created.sessionCode)).toBe(created.sessionCode);
  });

  it("reflects participants in status", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const status = await manager.getSessionStatus();
    expect(status.localParticipant.agent.name).toBe("paul-agent");
  });

  it("uses pairmesh.peer_not_found for unknown peer references", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    await expect(manager.sendToPeer("missing-peer", "hello")).rejects.toMatchObject({
      code: "pairmesh.peer_not_found"
    });
  });
});
