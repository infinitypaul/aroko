import { describe, expect, it } from "vitest";
import {
  appendProgressEvent,
  filterProgressEventsForViewer,
  type ActionExecutionRecord,
  type PeerId,
  type ProgressEvent
} from "@pairmesh/protocol";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import {
  buildStatusProgressEvent,
  mergeMirroredActionProgress,
  progressPhaseForActionStatus,
  projectProgressForViewer,
  seedActionProgressEvents
} from "./progress.js";
import { toActionSafeView } from "./session-bridge.js";

const TS = "2026-08-23T12:00:00.000Z";
const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;

function baseExecution(
  overrides: Partial<ActionExecutionRecord> &
    Pick<ActionExecutionRecord, "requesterParticipantId" | "targetParticipantId" | "status">
): ActionExecutionRecord {
  return {
    actionId: "act_progress_test",
    actionType: "repository.edit",
    capabilityId: "repository.edit",
    parameters: {},
    parameterDigest: "a".repeat(64),
    mutability: "mutation",
    createdAt: TS,
    updatedAt: TS,
    executorInvocationCount: 0,
    ...overrides
  };
}

function baseState(localId: PeerId, execution: ActionExecutionRecord): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-PROG001",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: TS,
      status: "active"
    },
    localParticipant: {
      participant: { id: localId } as LocalSessionState["localParticipant"]["participant"],
      agent: {} as LocalSessionState["localParticipant"]["agent"],
      developer: {} as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: [],
    inspectionThreads: [],
    inspectionExecutions: [],
    permissionRequests: [],
    actionExecutions: [execution],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: []
  };
}

describe("Stage 16 Prompt 2 — action progress foundation", () => {
  it("maps status + action type to coarse phases", () => {
    expect(progressPhaseForActionStatus("approval_required")).toBe("awaiting_owner_approval");
    expect(progressPhaseForActionStatus("executing", "repository.edit")).toBe("applying");
    expect(progressPhaseForActionStatus("executing", "tests.run")).toBe("running_named_tests");
    expect(progressPhaseForActionStatus("executing", "change.propose")).toBe("proposal_preparing");
    expect(progressPhaseForActionStatus("completed", "change.propose")).toBe("proposal_ready");
  });

  it("filters owner_only events from requester views", () => {
    const events: ProgressEvent[] = [
      buildStatusProgressEvent({
        actionId: "act_1",
        status: "executing",
        actionType: "repository.edit",
        timestamp: TS
      }),
      {
        operationId: "act_1",
        phase: "provider_started",
        visibility: "owner_only",
        timestamp: TS,
        message: "Local provider started."
      }
    ];
    expect(filterProgressEventsForViewer(events, "requester")).toHaveLength(1);
    expect(filterProgressEventsForViewer(events, "requester")[0]?.phase).toBe("applying");
    expect(filterProgressEventsForViewer(events, "owner")).toHaveLength(2);
  });

  it("synthesizes requester_safe progress from wire status deltas", () => {
    const first = mergeMirroredActionProgress(
      undefined,
      baseExecution({
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        status: "approval_required"
      })
    );
    expect(first.progressEvents?.map((e) => e.phase)).toEqual([
      "request_received",
      "awaiting_owner_approval"
    ]);
    expect(first.progressEvents?.every((e) => e.visibility === "requester_safe")).toBe(true);

    const second = mergeMirroredActionProgress(
      first,
      baseExecution({
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        status: "executing",
        updatedAt: "2026-08-23T12:01:00.000Z"
      })
    );
    expect(second.progressEvents?.at(-1)?.phase).toBe("applying");
    expect(second.progressEvents?.some((e) => e.visibility === "owner_only")).toBe(false);
  });

  it("exposes filtered progress on ActionSafeView", () => {
    let events = seedActionProgressEvents({
      actionId: "act_progress_test",
      status: "executing",
      actionType: "repository.edit",
      timestamp: TS
    });
    events = appendProgressEvent(events, {
      operationId: "act_progress_test",
      phase: "investigating",
      visibility: "owner_only",
      timestamp: TS,
      message: "Owner-only detail."
    });
    const execution = baseExecution({
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      status: "executing",
      progressEvents: events
    });

    const ownerView = toActionSafeView(baseState(kelvinId, execution), execution);
    expect(ownerView.latestProgress?.phase).toBe("investigating");
    expect(ownerView.progress.some((e) => e.visibility === "owner_only")).toBe(true);

    const requesterView = toActionSafeView(baseState(paulId, execution), execution);
    expect(requesterView.progress.every((e) => e.visibility === "requester_safe")).toBe(true);
    expect(requesterView.latestProgress?.phase).toBe("applying");

    const projected = projectProgressForViewer(baseState(paulId, execution), execution);
    expect(projected.progress).toEqual(requesterView.progress);
  });
});
