import { describe, expect, it } from "vitest";
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "../session/manager.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LOCAL_STATE_VERSION } from "../session/schemas.js";

describe("inspection thread persistence", () => {
  it("loads legacy state files without inspectionThreads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-thread-state-"));
    const stateFile = join(dir, "legacy.json");
    const store = new LocalStateStore({ stateFilePath: stateFile });

    const legacy = {
      stateVersion: "0.1.0",
      sessionCode: "PM-ABCDEF",
      session: {
        id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdAt: "2026-08-19T19:00:00.000Z",
        status: "active"
      },
      localParticipant: {
        participant: {
          id: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-08-19T19:00:00.000Z"
        },
        agent: {
          id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          name: "paul-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          displayName: "paul-agent"
        },
        a2aAgentUrl: "http://127.0.0.1:4501",
        isLocal: true
      },
      peers: []
    };

    await store.save(legacy as never);
    const loaded = await store.load();
    expect(loaded?.stateVersion).toBe(LOCAL_STATE_VERSION);
    expect(loaded?.inspectionThreads).toEqual([]);
  });
});

describe("SessionManager inspection threads", () => {
  it("rejects follow-up on closed thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-thread-close-"));
    const stateFile = join(dir, "state.json");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: stateFile })
    });

    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4501"
    });

    const threadId = "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed" as const;
    const state = await manager.getSessionStatus();
    void state;

    const store = new LocalStateStore({ stateFilePath: stateFile });
    const loaded = await store.load();
    if (!loaded) {
      throw new Error("missing state");
    }

    loaded.inspectionThreads.push({
      thread: {
        id: threadId,
        sessionId: loaded.session.id,
        initiatorPeerId: loaded.localParticipant.participant.id,
        targetPeerId: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        status: "closed",
        createdAt: "2026-08-19T19:00:00.000Z",
        updatedAt: "2026-08-19T19:00:00.000Z"
      },
      targetPeerName: "kelvin-agent",
      turns: []
    });
    await store.save(loaded);

    await expect(manager.followUpInspection(threadId, "retry path?")).rejects.toMatchObject({
      code: "pairmesh.inspection_thread_closed"
    });
  });
});
