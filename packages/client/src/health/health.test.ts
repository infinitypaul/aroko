import { describe, expect, it } from "vitest";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { buildLocalRuntimeHealth } from "./runtime-health.js";
import { fetchPeerHealth, clearPeerHealthCache } from "./peer-health.js";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalStateStore } from "../state/store.js";
import { LOCAL_STATE_VERSION } from "../session/schemas.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

describe("buildLocalRuntimeHealth", () => {
  it("reports ready when session is active and fake coding agent is available", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-health-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    await store.save({
      stateVersion: LOCAL_STATE_VERSION,
      sessionCode: "PM-ABCDEF",
      session: {
        id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdAt: "2026-08-19T19:00:00.000Z",
        status: "active"
      },
      localParticipant: {
        participant: {
          id: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          joinedAt: "2026-08-19T19:00:00.000Z"
        },
        agent: {
          id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          name: "kelvin-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
          displayName: "kelvin-agent"
        },
        a2aAgentUrl: "http://127.0.0.1:4502",
        isLocal: true
      },
      peers: [],
      inspectionThreads: [],
      inspectionExecutions: []
    });

    const health = await buildLocalRuntimeHealth("kelvin-agent", adapter, store, "prj_health");
    expect(health.status).toBe("ready");
    expect(health.readyForInspection).toBe(true);
    expect(health.agent.name).toBe("kelvin-agent");
    expect(health.codingAgent?.provider).toBe("fake");
    expect(JSON.stringify(health)).not.toMatch(/\/Users\/|PAIRMESH_WORKSPACE|\.json/);

    // Unauthenticated remote callers get liveness only — no coding agent or
    // project detail (ADR 0027).
    const minimal = await buildLocalRuntimeHealth("kelvin-agent", adapter, store, "prj_health", {
      includeOperationalDetail: false
    });
    expect(minimal.status).toBe("ready");
    expect(minimal.agent.name).toBe("kelvin-agent");
    expect(minimal.codingAgent).toBeUndefined();
    expect(minimal.project).toBeUndefined();
    expect(JSON.stringify(minimal)).not.toContain("prj_health");
  });
});

describe("fetchPeerHealth offline", () => {
  it("returns unreachable for offline peer", async () => {
    clearPeerHealthCache();
    const health = await fetchPeerHealth("kelvin-agent", "http://127.0.0.1:59998", {
      skipCache: true,
      timeoutMs: 500
    });
    expect(health.reachable).toBe(false);
  });
});
