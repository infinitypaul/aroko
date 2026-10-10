import { describe, expect, it } from "vitest";
import {
  prepareProgressTimeline,
  formatActivityLabel
} from "../../control-web/activity-present.js";
import {
  buildLiveCardModel,
  buildLiveEmptyCopy,
  buildNeedsYouCardModel,
  capabilityApprovalCopy,
  findWorkItem,
  humanizeDecisionError,
  humanizeDecisionSuccess,
  isActiveInspection,
  isActiveLiveAction,
  isTerminalLiveStatus,
  liveHtmlContainsForbiddenTech,
  mergeLiveWorkItems,
  mergeNeedsYouItems,
  resolveLivePollIntervalMs,
  timelineContainsForbidden
} from "../../control-web/live-present.js";
import { ACTIVITY_POLL_MS, DEFAULT_POLL_MS } from "../../control-web/activity-present.js";

const kelvinPeer = { displayName: "Kelvin", participantId: "peer_k", service: "payment-service" };

const runningInspection = {
  kind: "inspection",
  requestId: "insp_1",
  status: "running",
  terminal: false,
  question: "Where is payment retry handled?",
  peer: kelvinPeer,
  providerDisplayName: "Claude Code",
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:18.000Z",
  progress: [
    {
      operationId: "op1",
      phase: "provider_started",
      activityKind: "worker.started",
      timestamp: "2026-09-01T12:00:01.000Z",
      sequence: 1
    },
    {
      operationId: "op1",
      phase: "investigating",
      activityKind: "provider.message",
      message: "I'll trace the payment retry flow.",
      timestamp: "2026-09-01T12:00:02.000Z",
      sequence: 2
    },
    {
      operationId: "op1",
      phase: "reading_searching",
      activityKind: "search.started",
      message: "Searching repository…",
      timestamp: "2026-09-01T12:00:03.000Z",
      sequence: 3,
      safeMetadata: { query: "retry" }
    },
    {
      operationId: "op1",
      phase: "reading_searching",
      activityKind: "file.read",
      timestamp: "2026-09-01T12:00:04.000Z",
      sequence: 4,
      safeMetadata: { relativePath: "src/retry.ts" }
    },
    {
      operationId: "op1",
      phase: "investigating",
      activityKind: "finding",
      message: "retry dispatch path",
      timestamp: "2026-09-01T12:00:05.000Z",
      sequence: 5
    }
  ],
  latestProgress: {
    operationId: "op1",
    phase: "investigating",
    activityKind: "finding",
    message: "retry dispatch path",
    timestamp: "2026-09-01T12:00:05.000Z",
    sequence: 5
  }
};

const activeEdit = {
  actionId: "act_1",
  status: "executing",
  actionType: "repository.edit",
  actionLabel: "Apply change",
  needsApproval: false,
  peer: { displayName: "Sarah", participantId: "peer_s" },
  providerDisplayName: "Claude Code",
  requestSummary: "Prepare a change to retry failed captures",
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:31.000Z",
  progress: [],
  terminal: false
};

const pendingEdit = {
  actionId: "act_pending",
  status: "approval_required",
  actionType: "repository.edit",
  capabilityId: "repository.edit",
  actionLabel: "Apply change",
  needsApproval: true,
  canApproveOnce: true,
  canApproveSession: false,
  permissionRequestId: "perm_linked",
  peer: { displayName: "Sarah", participantId: "peer_s" },
  requestSummary: "Add retry handling for failed captures",
  createdAt: "2026-09-01T12:01:00.000Z",
  updatedAt: "2026-09-01T12:01:00.000Z"
};

const pendingPerm = {
  permissionRequestId: "perm_inspect",
  participantId: "peer_k",
  displayName: "Kelvin",
  capabilityId: "repository.inspect",
  correlationRequestId: "corr_1",
  status: "pending",
  createdAt: "2026-09-01T12:02:00.000Z",
  updatedAt: "2026-09-01T12:02:00.000Z",
  expiresAt: "2026-09-01T13:02:00.000Z"
};

describe("Stage 20 Prompt 4 — Live / Needs you helpers", () => {
  it("merges active inspections and actions by updatedAt", () => {
    const merged = mergeLiveWorkItems({
      actions: [activeEdit, pendingEdit],
      inspections: [runningInspection]
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.kind).toBe("action");
    expect(merged[0]?.id).toBe("act_1");
    expect(merged[1]?.kind).toBe("inspection");
    expect(isActiveInspection(runningInspection)).toBe(true);
    expect(isActiveLiveAction(pendingEdit)).toBe(false);
  });

  it("merges active collaborative tasks without labeling route health", () => {
    const task = {
      taskId: "task_1",
      status: "working",
      terminal: false,
      goalSummary: "Install the payments package",
      phaseLabel: "Working on request",
      waitingOn: "provider",
      waitingOnLabel: "Provider",
      requester: { displayName: "Kelvin" },
      owner: { displayName: "Paul" },
      providerDisplayName: "Claude Code",
      createdAt: "2026-09-01T12:03:00.000Z",
      updatedAt: "2026-09-01T12:03:30.000Z"
    };
    const merged = mergeLiveWorkItems({
      actions: [],
      inspections: [],
      tasks: [task, { ...task, taskId: "task_done", status: "completed", terminal: true }]
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("collaborative_task");
    const card = buildLiveCardModel(merged[0]!);
    expect(card?.headline).toBe("Kelvin → Paul");
    expect(card?.question).toMatch(/Install the payments package/i);
    expect(card?.elapsedLabel).toMatch(/Working on request · Claude Code/);
    expect(card?.recentActivity).toMatch(/Working|Provider/i);
    expect(JSON.stringify(card)).not.toMatch(/healthy/i);
  });

  it("builds Live cards with requester, question, provider, and activity", () => {
    const card = buildLiveCardModel(
      { ...runningInspection, kind: "inspection", id: "insp_1", workKey: "inspection:insp_1" },
      { fallbackProvider: "Claude Code" }
    );
    expect(card?.headline).toContain("Kelvin");
    expect(card?.headline).toContain("Claude Code");
    expect(card?.question).toMatch(/payment retry/i);
    expect(card?.recentActivity).toMatch(/Found/i);
    expect(card?.statusLabel).toBe("Working");
  });

  it("presents owner-rich timeline without private thought or absolute paths", () => {
    const timeline = prepareProgressTimeline(runningInspection.progress);
    const labels = timeline.map((e) => formatActivityLabel(e));
    expect(labels).toContain("Started");
    expect(labels.some((l) => l.includes("I'll trace"))).toBe(true);
    expect(labels.some((l) => /Reading src\/retry\.ts/i.test(l))).toBe(true);
    expect(labels.filter((l) => l === "Investigating").length).toBeLessThanOrEqual(1);
    expect(timelineContainsForbidden(timeline)).toBe(false);
    expect(liveHtmlContainsForbiddenTech(`<div>${labels.join(" ")} /Users/secret/repo</div>`)).toBe(
      true
    );
  });

  it("marks terminal inspection/action statuses clearly", () => {
    expect(isTerminalLiveStatus("inspection", "completed")).toBe(true);
    expect(isTerminalLiveStatus("inspection", "failed")).toBe(true);
    expect(isTerminalLiveStatus("inspection", "cancelled")).toBe(true);
    expect(isTerminalLiveStatus("inspection", "timed_out")).toBe(true);
    expect(isTerminalLiveStatus("action", "completed")).toBe(true);
    expect(isTerminalLiveStatus("action", "failed")).toBe(true);
    expect(isTerminalLiveStatus("action", "executing")).toBe(false);
  });

  it("provides a calm Live empty state", () => {
    const empty = buildLiveEmptyCopy();
    expect(empty.title).toMatch(/Nothing is running/i);
    expect(empty.detail).toMatch(/connected/i);
  });

  it("merges Needs you without duplicating linked permission+action", () => {
    const items = mergeNeedsYouItems({
      actions: [pendingEdit],
      permissions: [
        pendingPerm,
        {
          ...pendingPerm,
          permissionRequestId: "perm_linked",
          capabilityId: "repository.edit",
          actionType: "repository.edit"
        }
      ]
    });
    expect(items.some((i) => i.kind === "action" && i.id === "act_pending")).toBe(true);
    expect(items.some((i) => i.kind === "permission" && i.id === "perm_inspect")).toBe(true);
    expect(items.some((i) => i.id === "perm_linked")).toBe(false);
  });

  it("shows Answer (not Approve) for pending InputRequests and provenance on Actions", () => {
    const items = mergeNeedsYouItems({
      actions: [
        {
          ...pendingEdit,
          collaborativeProvenanceLabel: "Requested by Kelvin's agent for a collaborative goal",
          collaborativeInteraction: "approve"
        }
      ],
      permissions: [],
      pendingInputs: [
        {
          inputRequestId: "inq_1",
          taskId: "task_1",
          question: "Which package manager should I use?",
          status: "pending",
          owner: { displayName: "Paul" },
          goalSummary: "Install the payments package",
          createdAt: "2026-09-01T12:04:00.000Z",
          updatedAt: "2026-09-01T12:04:00.000Z"
        }
      ]
    });
    const inputCard = buildNeedsYouCardModel(items.find((i) => i.kind === "input_request")!);
    expect(inputCard?.cta).toBe("Answer");
    expect(inputCard?.allowOnceLabel).toBe("Answer");
    expect(inputCard?.denyLabel).toBeNull();
    expect(inputCard?.interaction).toBe("answer");
    expect(inputCard?.subtitle).toMatch(/package manager/i);
    expect(`${inputCard?.title} ${inputCard?.cta} ${inputCard?.allowOnceLabel}`).not.toMatch(
      /Approve|Deny/i
    );

    const actionCard = buildNeedsYouCardModel(items.find((i) => i.kind === "action")!);
    expect(actionCard?.allowOnceLabel).toBe("Approve once");
    expect(actionCard?.denyLabel).toBe("Deny");
    expect(actionCard?.provenance).toMatch(/Kelvin/i);
    expect(actionCard?.collaborativeInteraction).toBe("approve");
  });

  it("humanizes permission and edit approval copy", () => {
    const perm = buildNeedsYouCardModel({
      ...pendingPerm,
      kind: "permission",
      id: pendingPerm.permissionRequestId
    });
    expect(perm?.title).toMatch(/ask questions about your code/i);
    expect(perm?.allowOnceLabel).toBe("Allow this question");
    expect(perm?.allowSession).toBe(false);

    const edit = buildNeedsYouCardModel({
      ...pendingEdit,
      kind: "action",
      id: pendingEdit.actionId
    });
    expect(edit?.allowOnceLabel).toBe("Approve once");
    expect(edit?.helper).toMatch(/exact reviewed change once/i);
    expect(edit?.helper).toMatch(/MODIFY\s*\/\s*CREATE\s*\/\s*DELETE\s*\/\s*RENAME/i);
    expect(edit?.allowSession).toBe(false);

    expect(capabilityApprovalCopy("tests.run").allowOnce).toMatch(/test request/i);
    expect(capabilityApprovalCopy("tests.run").helper).not.toMatch(/\bshell command\b/i);
  });

  it("maps decision success/error and finds work items", () => {
    expect(humanizeDecisionSuccess("deny", { status: "denied" }).message).toMatch(/Denied/i);
    expect(humanizeDecisionSuccess("allow-once", { status: "executing" }).message).toMatch(
      /Approved once/i
    );
    expect(humanizeDecisionError("permission_not_found")).toMatch(/no longer available/i);
    expect(humanizeDecisionError("expired")).toMatch(/expired/i);

    const items = mergeLiveWorkItems({ actions: [activeEdit], inspections: [runningInspection] });
    expect(findWorkItem(items, "inspection", "insp_1")?.question).toMatch(/retry/i);
  });

  it("polls Live on the active cadence", () => {
    expect(resolveLivePollIntervalMs({ view: "live" })).toBe(ACTIVITY_POLL_MS);
    expect(resolveLivePollIntervalMs({ view: "needs-you", actions: [] })).toBe(DEFAULT_POLL_MS);
  });
});
