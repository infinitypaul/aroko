import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionManager } from "./manager.js";
import { LOCAL_STATE_VERSION, LocalSessionStateSchema } from "./schemas.js";
import { issueInboundCredential } from "../auth/credentials.js";
import { hashSecret, generateBearerToken } from "../auth/secrets.js";
import { validateInviteSecret } from "../auth/invites.js";
import { LocalStateStore } from "../state/store.js";

async function tempStore(): Promise<{ store: LocalStateStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-security-"));
  const path = join(dir, "state.json");
  return { path, store: new LocalStateStore({ stateFilePath: path }) };
}

describe("session security state", () => {
  it("creates an authenticated session with one redeemable invite", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    expect(created.security).toMatchObject({
      authenticated: true,
      securityVersion: "v1",
      requiresRePair: false,
      openInvites: 1
    });

    const state = await store.load();
    expect(state?.sessionSecurity?.invites).toHaveLength(1);
    expect(state?.sessionSecurity?.invites[0]?.secretHash).toBe(
      hashSecret(created.invite.inviteSecret)
    );
  });

  it("keeps prior open invites when a new invite is issued", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const second = await manager.createSessionInvite();
    expect(second.inviteSecret).not.toBe(created.invite.inviteSecret);

    const security = (await store.load())?.sessionSecurity;
    if (!security) {
      throw new Error("expected session security");
    }

    expect(validateInviteSecret(security, created.invite.inviteSecret).ok).toBe(true);
    expect(validateInviteSecret(security, second.inviteSecret).ok).toBe(true);
    expect((await manager.getSessionStatus()).security.openInvites).toBe(2);
  });

  it("revokes peer credentials on peer removal while retaining membership", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4101" });

    const state = await store.load();
    if (!state?.sessionSecurity) {
      throw new Error("expected session security");
    }

    const peerRecord = {
      ...state.localParticipant,
      isLocal: false,
      a2aAgentUrl: "http://127.0.0.1:4102",
      outboundBearer: generateBearerToken()
    };
    const issued = issueInboundCredential(peerRecord.participant.id);
    await store.save({
      ...state,
      peers: [peerRecord],
      sessionSecurity: {
        ...state.sessionSecurity,
        acceptedInbound: [issued.credential]
      }
    });

    const beforeRemoval = await manager.getSessionStatus();
    expect(beforeRemoval.security.activeCredentials).toHaveLength(1);

    const removed = await manager.removePeer(peerRecord.agent.name);
    expect(removed.revokedCredentials).toBe(1);

    const afterRemoval = await manager.getSessionStatus();
    expect(afterRemoval.peers).toHaveLength(1);
    expect(afterRemoval.peers[0]?.outboundBearer).toBeUndefined();
    expect(afterRemoval.security.activeCredentials).toHaveLength(0);
    expect(afterRemoval.security.revokedCredentials).toBe(1);
  });

  it("keeps credentials across restarts and clears them when the session closes", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const state = await store.load();
    if (!state?.sessionSecurity) {
      throw new Error("expected session security");
    }
    const peerRecord = {
      ...state.localParticipant,
      isLocal: false,
      a2aAgentUrl: "http://127.0.0.1:4102",
      outboundBearer: generateBearerToken()
    };
    const issued = issueInboundCredential(peerRecord.participant.id);
    await store.save({
      ...state,
      peers: [peerRecord],
      sessionSecurity: { ...state.sessionSecurity, acceptedInbound: [issued.credential] }
    });

    // Restart: a fresh manager over the same file keeps both directions usable.
    const restarted = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: store.stateFilePath })
    });
    const status = await restarted.getSessionStatus();
    expect(status.sessionCode).toBe(created.sessionCode);
    expect(status.peers[0]?.outboundBearer).toBe(peerRecord.outboundBearer);
    expect(status.security.activeCredentials).toHaveLength(1);

    // Leaving discards every credential the session issued.
    await restarted.leaveSession();
    expect(await store.load()).toBeFalsy();
    await expect(restarted.getSessionStatus()).rejects.toMatchObject({
      code: "pairmesh.session_not_found"
    });
  });

  it("marks pre-authentication sessions as requiring a re-pair", async () => {
    const { store, path } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:4101" });

    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete raw.sessionSecurity;
    raw.stateVersion = "0.3.0";
    await writeFile(path, JSON.stringify(raw), "utf8");

    const migrated = LocalSessionStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(migrated.stateVersion).toBe(LOCAL_STATE_VERSION);
    expect(migrated.requiresRePair).toBe(true);
    expect(migrated.sessionSecurity).toBeUndefined();

    const reopened = new SessionManager({ stateStore: store });
    const status = await reopened.getSessionStatus();
    expect(status.security).toMatchObject({ authenticated: false, requiresRePair: true });

    // Protected operations must refuse to run without session credentials.
    await expect(reopened.createSessionInvite()).rejects.toMatchObject({
      code: "pairmesh.session_requires_repair"
    });
  });
});
