import { describe, expect, it } from "vitest";
import {
  appendProgressEvent,
  filterProgressEventsForViewer,
  type ActionExecutionRecord,
  type PeerId,
  type ProgressEvent
} from "@pairmesh/protocol";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { toActionSafeView } from "../action/session-bridge.js";
import { formatRequesterProgressTimeline, formatRequesterTerminalOutcome } from "./ask-intent.js";
import { presentActionHuman } from "./present.js";

const TS = "2026-08-27T12:00:00.000Z";
const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;

/**
 * Same Kelvin-side operation: rich owner activity + requester_safe lifecycle.
 * Paul must never see file/search/tool detail from this record via projection.
 */
function kelvinRichProposeTimeline(): ProgressEvent[] {
  let events: ProgressEvent[] = [];
  const push = (event: ProgressEvent) => {
    events = appendProgressEvent(events, event);
  };

  push({
    operationId: "act_asym",
    phase: "request_received",
    visibility: "requester_safe",
    timestamp: TS,
    message: "Request received."
  });
  push({
    operationId: "act_asym",
    phase: "provider_started",
    visibility: "owner_only",
    timestamp: TS,
    activityKind: "worker.started",
    message: "Started",
    providerEventId: "w0"
  });
  push({
    operationId: "act_asym",
    phase: "reading_searching",
    visibility: "owner_only",
    timestamp: TS,
    activityKind: "file.read",
    message: "Reading src/retry.ts",
    safeMetadata: { relativePath: "src/retry.ts", toolName: "Read" },
    providerEventId: "r1"
  });
  push({
    operationId: "act_asym",
    phase: "reading_searching",
    visibility: "owner_only",
    timestamp: TS,
    activityKind: "search.started",
    message: "Searching retryRecord.reference",
    safeMetadata: { query: "retryRecord.reference", toolName: "Grep" },
    providerEventId: "s1"
  });
  push({
    operationId: "act_asym",
    phase: "reading_searching",
    visibility: "owner_only",
    timestamp: TS,
    activityKind: "search.completed",
    message: "Search complete",
    providerEventId: "s1c"
  });
  push({
    operationId: "act_asym",
    phase: "proposal_preparing",
    visibility: "requester_safe",
    timestamp: TS,
    activityKind: "proposal.preparing",
    message: "Preparing change…"
  });
  push({
    operationId: "act_asym",
    phase: "proposal_ready",
    visibility: "requester_safe",
    timestamp: TS,
    activityKind: "proposal.ready",
    message: "Waiting for approval"
  });
  push({
    operationId: "act_asym",
    phase: "awaiting_owner_approval",
    visibility: "requester_safe",
    timestamp: TS,
    message: "Waiting for owner approval."
  });

  return events;
}

function executionWithProgress(progressEvents: ProgressEvent[]): ActionExecutionRecord {
  return {
    actionId: "act_asym",
    actionType: "change.propose",
    capabilityId: "change.propose",
    parameters: { instruction: "Fix payment retry" },
    parameterDigest: "a".repeat(64),
    mutability: "mutation",
    createdAt: TS,
    updatedAt: TS,
    executorInvocationCount: 1,
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    status: "approval_required",
    progressEvents
  };
}

function stateFor(localId: PeerId, execution: ActionExecutionRecord): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ASYM001",
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

describe("Stage 17 Prompt 5 — Kelvin-rich vs Paul-safe asymmetry", () => {
  it("projects the same operation asymmetrically at the model layer", () => {
    const progressEvents = kelvinRichProposeTimeline();
    const execution = executionWithProgress(progressEvents);

    const ownerView = toActionSafeView(stateFor(kelvinId, execution), execution);
    const requesterView = toActionSafeView(stateFor(paulId, execution), execution);

    const ownerLabels = ownerView.progress.map((e) => e.activityKind ?? e.phase);
    expect(ownerLabels).toEqual([
      "request_received",
      "worker.started",
      "file.read",
      "search.started",
      "search.completed",
      "proposal.preparing",
      "proposal.ready",
      "awaiting_owner_approval"
    ]);
    expect(ownerView.progress.some((e) => e.safeMetadata?.relativePath === "src/retry.ts")).toBe(
      true
    );
    expect(ownerView.progress.some((e) => e.safeMetadata?.query === "retryRecord.reference")).toBe(
      true
    );

    expect(requesterView.progress.every((e) => e.visibility === "requester_safe")).toBe(true);
    expect(requesterView.progress.map((e) => e.phase)).toEqual([
      "request_received",
      "proposal_preparing",
      "proposal_ready",
      "awaiting_owner_approval"
    ]);
    expect(requesterView.progress.some((e) => e.activityKind === "file.read")).toBe(false);
    expect(requesterView.progress.some((e) => e.activityKind === "search.started")).toBe(false);
    expect(requesterView.progress.some((e) => e.activityKind === "worker.started")).toBe(false);

    const requesterJson = JSON.stringify(requesterView.progress);
    expect(requesterJson).not.toContain("src/retry");
    expect(requesterJson).not.toContain("retryRecord");
    expect(requesterJson).not.toContain("Read");
    expect(requesterJson).not.toContain("Grep");
    expect(requesterJson).not.toContain("providerEventId");
    expect(requesterJson).not.toContain("w0");

    const paulTimeline = formatRequesterProgressTimeline({
      progress: requesterView.progress,
      peerLabel: "Kelvin · payment-service",
      status: requesterView.status
    });
    expect(paulTimeline).toContain("Kelvin · payment-service");
    expect(paulTimeline).toContain("Request delivered");
    expect(paulTimeline).toContain("Preparing change…");
    expect(paulTimeline).toContain("Waiting for approval");
    expect(paulTimeline).not.toContain("Reading");
    expect(paulTimeline).not.toContain("src/");
    expect(paulTimeline).not.toMatch(/act_/);
    expect(paulTimeline).not.toMatch(/peer_/);

    const presented = presentActionHuman(requesterView, "Kelvin · payment-service");
    expect(presented).toContain("Waiting for approval");
    expect(presented).toContain("Inbox");
    expect(presented).not.toContain("src/retry.ts");
  });

  it("drops hostile requester_safe metadata and owner-detail messages at filter boundary", () => {
    const hostile = filterProgressEventsForViewer(
      [
        {
          operationId: "act_x",
          phase: "proposal_preparing",
          visibility: "requester_safe",
          timestamp: TS,
          activityKind: "proposal.preparing",
          message: "Reading src/secret.ts",
          safeMetadata: {
            relativePath: "src/secret.ts",
            query: "password=",
            toolName: "Bash",
            chainOfThought: "never"
          } as ProgressEvent["safeMetadata"],
          providerEventId: "hostile-1"
        }
      ],
      "requester"
    );
    expect(hostile).toHaveLength(1);
    expect(hostile[0]?.safeMetadata).toBeUndefined();
    expect(hostile[0]?.message).toBeUndefined();
    expect(hostile[0]?.providerEventId).toBeUndefined();
    expect(JSON.stringify(hostile)).not.toContain("secret");
    expect(JSON.stringify(hostile)).not.toContain("password");
    expect(JSON.stringify(hostile)).not.toContain("Bash");
    expect(JSON.stringify(hostile)).not.toContain("never");
  });

  it("keeps coarse requester_safe events visible for providers without rich kinds", () => {
    const coarse = filterProgressEventsForViewer(
      [
        {
          operationId: "act_c",
          phase: "proposal_preparing",
          visibility: "requester_safe",
          timestamp: TS,
          message: "Preparing proposal."
        },
        {
          operationId: "act_c",
          phase: "proposal_ready",
          visibility: "requester_safe",
          timestamp: TS,
          message: "Proposal ready."
        }
      ],
      "requester"
    );
    expect(coarse.map((e) => e.phase)).toEqual(["proposal_preparing", "proposal_ready"]);
    expect(
      formatRequesterProgressTimeline({
        progress: coarse,
        peerLabel: "Kelvin"
      })
    ).toContain("Preparing change…");
  });

  it("renders clear terminal outcomes without owner activity", () => {
    expect(
      formatRequesterTerminalOutcome({
        status: "denied",
        peerLabel: "Kelvin"
      })
    ).toBe("Kelvin denied the request.");
    expect(
      formatRequesterTerminalOutcome({
        status: "expired"
      })
    ).toMatch(/expired/i);
    expect(
      formatRequesterTerminalOutcome({
        status: "failed",
        error: { message: "Provider exited with code 1" }
      })
    ).toBe("Failed: Provider exited with code 1");
    expect(
      formatRequesterTerminalOutcome({
        status: "failed",
        error: { message: "Reading src/retry.ts" }
      })
    ).toBe("The request failed.");
    expect(
      formatRequesterTerminalOutcome({
        status: "cancelled"
      })
    ).toBe("Cancelled.");
    expect(
      formatRequesterTerminalOutcome({
        error: { code: "pairmesh.peer_unreachable" },
        peerLabel: "Kelvin · payment-service"
      })
    ).toMatch(/unavailable/i);
  });
});
