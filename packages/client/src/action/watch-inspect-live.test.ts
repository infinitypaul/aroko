import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InspectionThreadIdSchema,
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_SECURITY_VERSION,
  PeerIdSchema,
  SessionIdSchema,
  type ProgressEvent
} from "@pairmesh/protocol";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { processPairMeshInspectionRequest } from "../inspect/handler.js";
import { LocalStateStore } from "../state/store.js";
import { LOCAL_STATE_VERSION } from "../session/schemas.js";
import { listReceiverInspectionViews } from "../session/receiver-inspections.js";
import {
  enrichInspectionForWatch,
  formatWatchHeader,
  formatWatchSelectionLine,
  formatWatchTimelineLines,
  isWatchableActiveInspection,
  isWatchableActiveWork,
  mergeWatchCandidates,
  watchUxContainsOpaqueWorkId,
  type WatchActionCandidate
} from "./watch-present.js";
import { mapInspectionProgressToProgressEvent } from "./provider-activity.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

async function seedReceiverState(stateFile: string): Promise<void> {
  const store = new LocalStateStore({ stateFilePath: stateFile });
  await store.save({
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-WATCH2",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-27T19:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: kelvinId,
        sessionId,
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-08-27T19:00:00.000Z"
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
        displayName: "Kelvin"
      },
      a2aAgentUrl: "http://127.0.0.1:4502",
      isLocal: true,
      serviceLabel: "payment-service"
    },
    peers: [
      {
        participant: {
          id: paulId,
          sessionId,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-08-27T19:00:00.000Z"
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
          displayName: "Paul"
        },
        a2aAgentUrl: "http://127.0.0.1:4501",
        isLocal: false
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: [],
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: [],
    sessionSecurity: {
      securityVersion: PAIRMESH_SECURITY_VERSION,
      invites: [],
      acceptedInbound: [],
      capabilityGrants: []
    }
  });
}

describe("Stage 17 — watch discovers receiver inspections", () => {
  it("flushes mid-run inspect progress so watch can attach before completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-watch-inspect-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);

    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace, 120);
    const store = new LocalStateStore({ stateFilePath: stateFile });
    const request = {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      sessionId,
      threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01"),
      requestId: "req_watch_midflight",
      question: "Where does rebuildPaymentFromRetryRecord live for payment retry?",
      turnNumber: 1
    };

    const pending = processPairMeshInspectionRequest(request, adapter, store, {
      participantId: paulId
    });

    let sawRunningWithProgress = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const state = await store.load();
      const active = listReceiverInspectionViews(state!, "active");
      if (
        active.length === 1 &&
        active[0]!.status === "running" &&
        active[0]!.progress.some((event) => event.activityKind === "file.read")
      ) {
        sawRunningWithProgress = true;
        const enriched = enrichInspectionForWatch(active[0]!, {
          codingAgentProviderId: "fake",
          localService: "payment-service"
        });
        expect(isWatchableActiveWork(enriched)).toBe(true);
        expect(formatWatchSelectionLine(enriched)).toContain("Paul · payment-service");
        expect(watchUxContainsOpaqueWorkId(formatWatchSelectionLine(enriched))).toBe(false);
        const header = formatWatchHeader(enriched).join("\n");
        expect(header).toContain("Paul →");
        expect(watchUxContainsOpaqueWorkId(header)).toBe(false);
        break;
      }
    }

    const response = await pending;
    expect(response.accepted).toBe(true);
    expect(sawRunningWithProgress).toBe(true);

    const finalState = await store.load();
    const views = listReceiverInspectionViews(finalState!, "all");
    expect(views).toHaveLength(1);
    expect(views[0]!.terminal).toBe(true);
    expect(views[0]!.status).toBe("completed");
    expect(isWatchableActiveInspection(views[0]!)).toBe(false);

    const lines = formatWatchTimelineLines(views[0]!.progress, { live: false });
    expect(lines.some((line) => line.label === "Started")).toBe(true);
    expect(lines.some((line) => line.label === "Reading src/retry.ts…")).toBe(true);
    expect(lines.some((line) => line.label === "Inspection completed")).toBe(true);
    expect(lines.every((line) => !watchUxContainsOpaqueWorkId(line.label))).toBe(true);
  });

  it("lists an already-active inspection for watch attach-after-start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-watch-inspect-active-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);
    const store = new LocalStateStore({ stateFilePath: stateFile });

    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace, 80);
    const pending = processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02"),
        requestId: "req_watch_already_active",
        question: "Inspect src/retry.ts customerId null path",
        turnNumber: 1
      },
      adapter,
      store,
      { participantId: paulId }
    );

    let activeView = null as ReturnType<typeof listReceiverInspectionViews>[number] | null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const state = await store.load();
      const active = listReceiverInspectionViews(state!, "active");
      if (active[0]?.status === "running") {
        activeView = active[0]!;
        break;
      }
    }
    expect(activeView).not.toBeNull();
    expect(activeView!.requestId).toBe("req_watch_already_active");
    expect(isWatchableActiveInspection(activeView!)).toBe(true);

    await pending;
  });

  it("merges inspect + action candidates without ID leakage", () => {
    const inspection = enrichInspectionForWatch({
      kind: "inspection",
      requestId: "req_018f7b8a-4f31-7cc5-9a7c-aaaaaaaaaaaa",
      status: "running",
      question: "Inspect retry rebuild",
      peer: { participantId: paulId, displayName: "Paul" },
      createdAt: "2026-08-27T19:00:02.000Z",
      updatedAt: "2026-08-27T19:00:02.000Z",
      terminal: false,
      progress: []
    });
    const action = {
      kind: "action" as const,
      actionId: "act_018f7b8a-4f31-7cc5-9a7c-bbbbbbbbbbbb",
      status: "executing",
      actionType: "change.propose",
      capabilityId: "change.propose",
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-08-27T19:00:01.000Z",
      updatedAt: "2026-08-27T19:00:03.000Z",
      terminal: false,
      progress: [],
      actionLabel: "Change proposal",
      needsApproval: false,
      canApproveOnce: true,
      canApproveSession: false,
      peer: { participantId: paulId, displayName: "Paul" },
      localService: "payment-service",
      requestSummary: "Propose retry fix"
    } as WatchActionCandidate;

    const merged = mergeWatchCandidates({ actions: [action], inspections: [inspection] });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.kind).toBe("action");
    expect(merged[1]?.kind).toBe("inspection");
    expect(isWatchableActiveWork(merged[0]!)).toBe(true);
    expect(isWatchableActiveWork(merged[1]!)).toBe(true);
    for (const entry of merged) {
      expect(watchUxContainsOpaqueWorkId(formatWatchSelectionLine(entry))).toBe(false);
    }
  });

  it("maps provider-neutral coarse inspection progress for watch fallback", () => {
    const events: ProgressEvent[] = [
      mapInspectionProgressToProgressEvent({
        operationId: "req_coarse",
        event: { phase: "coding-agent-starting", message: "Starting local inspection." },
        timestamp: "2026-08-27T19:10:00.000Z",
        sequence: 1
      }),
      mapInspectionProgressToProgressEvent({
        operationId: "req_coarse",
        event: { phase: "inspecting", message: "Searching repository." },
        timestamp: "2026-08-27T19:10:01.000Z",
        sequence: 2
      }),
      mapInspectionProgressToProgressEvent({
        operationId: "req_coarse",
        event: { phase: "completed", message: "Inspection completed." },
        timestamp: "2026-08-27T19:10:02.000Z",
        sequence: 3
      })
    ];
    const lines = formatWatchTimelineLines(events, { live: false });
    expect(lines.map((line) => line.label)).toEqual([
      "Started",
      "Searching repository.",
      "Inspection completed"
    ]);
  });
});
