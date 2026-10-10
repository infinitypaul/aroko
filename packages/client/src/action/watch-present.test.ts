import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "@pairmesh/protocol";
import {
  diffWatchTimelineKeys,
  formatWatchEmptyState,
  formatWatchHeader,
  formatWatchLeavingReviewHoldForNewWork,
  formatWatchReviewHandoff,
  formatWatchSelectionLine,
  formatWatchSelectionPrompt,
  formatWatchTimelineLines,
  formatWatchWaitingState,
  isWatchableActiveAction,
  isWatchableActiveInspection,
  isWatchableActiveWork,
  isWatchActionLive,
  isWatchInspectionCandidate,
  isWatchProposalReviewable,
  isWatchWorkLive,
  mergeWatchCandidates,
  prepareWatchTimeline,
  progressEventWatchKey,
  resolveWatchPollIntervalMs,
  shouldKeepWaitingForActiveWork,
  shouldResumeIdleWaitAfterWatch,
  shouldHoldWatchForReviewKeypress,
  shouldReleaseWatchReviewHoldForOtherWork,
  watchUxContainsOpaqueActionId,
  watchUxContainsOpaqueWorkId,
  WATCH_POLL_MS,
  WATCH_IDLE_POLL_MS,
  type WatchActionCandidate,
  type WatchInspectionCandidate
} from "./watch-present.js";

function event(
  partial: Partial<ProgressEvent> & Pick<ProgressEvent, "phase" | "timestamp" | "operationId">
): ProgressEvent {
  return {
    visibility: "owner_only",
    ...partial
  };
}

function candidate(partial: Partial<WatchActionCandidate>): WatchActionCandidate {
  return {
    actionId: "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b012" as WatchActionCandidate["actionId"],
    status: "executing",
    actionType: "change.propose",
    capabilityId: "change.propose",
    requesterParticipantId: "peer_paul" as WatchActionCandidate["requesterParticipantId"],
    targetParticipantId: "peer_kelvin" as WatchActionCandidate["targetParticipantId"],
    createdAt: "2026-08-27T18:00:00.000Z",
    updatedAt: "2026-08-27T18:00:01.000Z",
    terminal: false,
    progress: [],
    actionLabel: "Change proposal",
    needsApproval: false,
    canApproveOnce: true,
    canApproveSession: false,
    ...partial
  };
}

describe("Stage 17 Prompt 8 — watch presentation", () => {
  it("reports empty / one / multiple selection UX without opaque IDs", () => {
    expect(formatWatchEmptyState()).toBe("No active PairMesh work right now.");
    expect(formatWatchSelectionPrompt()).toBe("What do you want to watch?");

    const one = candidate({
      peer: { participantId: "p1", displayName: "Paul" },
      localService: "payment-service",
      requestSummary: "Fix payment retry",
      providerDisplayName: "Claude Code"
    });
    const two = candidate({
      actionId: "act_028f7b8a-4f31-7cc5-9a7c-fd3394f4b099" as WatchActionCandidate["actionId"],
      peer: { participantId: "p2", displayName: "Sarah" },
      localService: "identity-service",
      requestSummary: "Investigate refresh token"
    });

    expect(isWatchableActiveAction(one)).toBe(true);
    expect(isWatchableActiveAction({ status: "completed", terminal: true })).toBe(false);

    const line1 = formatWatchSelectionLine(one, { selected: true });
    const line2 = formatWatchSelectionLine(two, { selected: false });
    expect(line1).toBe("› Paul · payment-service — Fix payment retry");
    expect(line2).toBe("  Sarah · identity-service — Investigate refresh token");
    expect(watchUxContainsOpaqueActionId(line1)).toBe(false);
    expect(watchUxContainsOpaqueActionId(line2)).toBe(false);

    const header = formatWatchHeader(one).join("\n");
    expect(header).toContain("Paul → payment-service");
    expect(header).toContain("● LIVE");
    expect(header).toContain("Claude Code");
    expect(header).toContain("Fix payment retry");
    expect(watchUxContainsOpaqueActionId(header)).toBe(false);
  });

  it("renders Claude-shaped rich activity with ordering and live marker", () => {
    const events: ProgressEvent[] = [
      event({
        operationId: "act_1",
        phase: "provider_started",
        activityKind: "worker.started",
        timestamp: "2026-08-27T18:00:01.000Z",
        sequence: 1,
        providerEventId: "claude:init",
        visibility: "requester_safe"
      }),
      event({
        operationId: "act_1",
        phase: "reading_searching",
        activityKind: "file.read",
        timestamp: "2026-08-27T18:00:02.000Z",
        sequence: 2,
        providerEventId: "claude:read1",
        safeMetadata: { relativePath: "src/retry.ts" }
      }),
      event({
        operationId: "act_1",
        phase: "reading_searching",
        activityKind: "search.started",
        timestamp: "2026-08-27T18:00:03.000Z",
        sequence: 3,
        providerEventId: "claude:grep1",
        safeMetadata: { query: "retryRecord.reference" }
      }),
      event({
        operationId: "act_1",
        phase: "reading_searching",
        activityKind: "search.completed",
        timestamp: "2026-08-27T18:00:04.000Z",
        sequence: 4,
        providerEventId: "claude:grep1:done"
      }),
      event({
        operationId: "act_1",
        phase: "reading_searching",
        activityKind: "file.read",
        timestamp: "2026-08-27T18:00:05.000Z",
        sequence: 5,
        providerEventId: "claude:read2",
        safeMetadata: { relativePath: "src/payment.ts" }
      })
    ];

    const duplicated = prepareWatchTimeline([...events, events[1]!, events[2]!]);
    expect(duplicated).toHaveLength(5);

    const lines = formatWatchTimelineLines(events, { live: true });
    expect(lines.map((line) => `${line.marker} ${line.label}`)).toEqual([
      "● Started",
      "● Reading src/retry.ts…",
      "● Searching retryRecord.reference…",
      "◐ Reading src/payment.ts…"
    ]);
    expect(lines.every((line) => !watchUxContainsOpaqueActionId(line.label))).toBe(true);
  });

  it("renders Gemini-shaped rich activity through the same presentation contract", () => {
    const events: ProgressEvent[] = [
      event({
        operationId: "act_g",
        phase: "provider_started",
        activityKind: "worker.started",
        timestamp: "2026-08-27T18:10:00.000Z",
        sequence: 1,
        providerEventId: "gemini:init",
        visibility: "requester_safe",
        safeMetadata: { provider: "gemini-cli" }
      }),
      event({
        operationId: "act_g",
        phase: "reading_searching",
        activityKind: "file.read",
        timestamp: "2026-08-27T18:10:01.000Z",
        sequence: 2,
        providerEventId: "gemini:read",
        safeMetadata: {
          relativePath: "src/retry.ts",
          toolName: "read_file",
          provider: "gemini-cli"
        }
      }),
      event({
        operationId: "act_g",
        phase: "reading_searching",
        activityKind: "search.started",
        timestamp: "2026-08-27T18:10:02.000Z",
        sequence: 3,
        providerEventId: "gemini:grep",
        safeMetadata: {
          query: "retryRecord.reference",
          toolName: "grep_search",
          provider: "gemini-cli"
        }
      }),
      event({
        operationId: "act_g",
        phase: "reading_searching",
        activityKind: "search.completed",
        timestamp: "2026-08-27T18:10:03.000Z",
        sequence: 4,
        providerEventId: "gemini:grep:done",
        safeMetadata: { toolName: "grep_search", provider: "gemini-cli" }
      })
    ];

    const lines = formatWatchTimelineLines(events, { live: false });
    expect(lines.map((line) => line.label)).toEqual([
      "Started",
      "Reading src/retry.ts…",
      "Searching retryRecord.reference…"
    ]);
    expect(lines.every((line) => line.marker === "✓")).toBe(true);
  });

  it("falls back to coarse phase labels when activityKind is absent", () => {
    const events: ProgressEvent[] = [
      event({
        operationId: "act_c",
        phase: "provider_started",
        timestamp: "2026-08-27T18:20:00.000Z",
        sequence: 1,
        visibility: "requester_safe"
      }),
      event({
        operationId: "act_c",
        phase: "investigating",
        timestamp: "2026-08-27T18:20:01.000Z",
        sequence: 2
      }),
      event({
        operationId: "act_c",
        phase: "completed",
        activityKind: "worker.completed",
        timestamp: "2026-08-27T18:20:02.000Z",
        sequence: 3,
        visibility: "requester_safe"
      })
    ];
    const lines = formatWatchTimelineLines(events, { live: false });
    expect(lines.map((line) => line.label)).toEqual(["Started", "Investigating", "Completed"]);
  });

  it("prefers inspection completion message on worker.completed", () => {
    const lines = formatWatchTimelineLines(
      [
        event({
          operationId: "req_1",
          phase: "completed",
          activityKind: "worker.completed",
          message: "Inspection completed.",
          timestamp: "t",
          sequence: 1,
          visibility: "requester_safe"
        })
      ],
      { live: false }
    );
    expect(lines[0]?.label).toBe("Inspection completed");
  });

  it("surfaces inspections in selection/header UX without opaque IDs", () => {
    const inspection: WatchInspectionCandidate = {
      kind: "inspection",
      requestId: "req_018f7b8a-4f31-7cc5-9a7c-fd3394f4b012",
      status: "running",
      question: "Ask Kelvin to inspect src/retry.ts",
      peer: { participantId: "p1", displayName: "Paul" },
      localService: "payment-service",
      createdAt: "2026-08-27T18:00:00.000Z",
      updatedAt: "2026-08-27T18:00:01.000Z",
      terminal: false,
      progress: [],
      providerDisplayName: "Claude Code",
      requestSummary: "Ask Kelvin to inspect src/retry.ts",
      actionLabel: "Inspection"
    };
    const action = candidate({
      peer: { participantId: "p2", displayName: "Sarah" },
      localService: "identity-service",
      requestSummary: "Fix refresh token"
    });

    expect(isWatchableActiveInspection(inspection)).toBe(true);
    expect(isWatchableActiveWork(inspection)).toBe(true);
    expect(isWatchWorkLive(inspection)).toBe(true);

    const line = formatWatchSelectionLine(inspection, { selected: true });
    expect(line).toBe("› Paul · payment-service — Ask Kelvin to inspect src/retry.ts");
    expect(watchUxContainsOpaqueWorkId(line)).toBe(false);

    const header = formatWatchHeader(inspection).join("\n");
    expect(header).toContain("Paul →");
    expect(header).toContain("Claude Code");
    expect(header).toContain("● LIVE");
    expect(watchUxContainsOpaqueWorkId(header)).toBe(false);

    const merged = mergeWatchCandidates({
      actions: [action],
      inspections: [inspection]
    });
    expect(merged).toHaveLength(2);
    expect(merged.some((entry) => isWatchInspectionCandidate(entry))).toBe(true);
    expect(
      merged.every((entry) => !watchUxContainsOpaqueWorkId(formatWatchSelectionLine(entry)))
    ).toBe(true);
  });

  it("diffs live arrivals by providerEventId and keeps poll intervals tight while watching", () => {
    const first = formatWatchTimelineLines(
      [
        event({
          operationId: "act_1",
          phase: "provider_started",
          activityKind: "worker.started",
          timestamp: "t1",
          sequence: 1,
          providerEventId: "e1",
          visibility: "requester_safe"
        })
      ],
      { live: true }
    );
    const seen = new Set(first.map((line) => line.key));
    const secondBatch = formatWatchTimelineLines(
      [
        event({
          operationId: "act_1",
          phase: "provider_started",
          activityKind: "worker.started",
          timestamp: "t1",
          sequence: 1,
          providerEventId: "e1",
          visibility: "requester_safe"
        }),
        event({
          operationId: "act_1",
          phase: "reading_searching",
          activityKind: "file.read",
          timestamp: "t2",
          sequence: 2,
          providerEventId: "e2",
          safeMetadata: { relativePath: "src/retry.ts" }
        })
      ],
      { live: true }
    );
    const fresh = diffWatchTimelineKeys(seen, secondBatch);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.label).toBe("Reading src/retry.ts…");
    expect(progressEventWatchKey(secondBatch[1]!.event)).toBe("id:e2");

    expect(resolveWatchPollIntervalMs({ watching: true })).toBe(WATCH_POLL_MS);
    expect(resolveWatchPollIntervalMs({ action: { status: "executing" } })).toBe(WATCH_POLL_MS);
    expect(resolveWatchPollIntervalMs({})).toBe(WATCH_IDLE_POLL_MS);
  });

  it("shows proposal-ready review handoff without approving", () => {
    const action = candidate({
      status: "executing",
      progress: [
        event({
          operationId: "act_1",
          phase: "proposal_ready",
          activityKind: "proposal.ready",
          timestamp: "t",
          sequence: 9
        })
      ]
    });
    expect(isWatchProposalReviewable(action)).toBe(true);
    expect(isWatchActionLive(action)).toBe(true);
    const handoff = formatWatchReviewHandoff().join("\n");
    expect(handoff).toContain("✓ Proposal ready");
    expect(handoff).toContain("Waiting for your review.");
    expect(handoff).toContain("Press R to open Review.");
    expect(handoff.toLowerCase()).not.toContain("approve");
    expect(handoff.toLowerCase()).not.toContain("deny");
  });

  it("never embeds opaque action ids in normal watch strings", () => {
    const blob = [
      formatWatchEmptyState(),
      formatWatchWaitingState(),
      formatWatchSelectionPrompt(),
      ...formatWatchReviewHandoff(),
      ...formatWatchHeader(
        candidate({
          peer: { participantId: "x", displayName: "Paul" },
          localService: "payment-service",
          requestSummary: "Fix payment retry reference"
        })
      )
    ].join("\n");
    expect(watchUxContainsOpaqueActionId(blob)).toBe(false);
  });

  it("keeps idle watch waiting for the next active action instead of exiting", () => {
    expect(formatWatchWaitingState()).toBe("Waiting for next PairMesh work…");
    expect(
      shouldKeepWaitingForActiveWork({ activeCount: 0, once: false, stopRequested: false })
    ).toBe(true);
    expect(
      shouldKeepWaitingForActiveWork({ activeCount: 1, once: false, stopRequested: false })
    ).toBe(false);
    expect(
      shouldKeepWaitingForActiveWork({ activeCount: 0, once: true, stopRequested: false })
    ).toBe(false);
    expect(
      shouldKeepWaitingForActiveWork({ activeCount: 0, once: false, stopRequested: true })
    ).toBe(false);

    expect(shouldResumeIdleWaitAfterWatch({ once: false, stopRequested: false })).toBe(true);
    expect(shouldResumeIdleWaitAfterWatch({ once: true, stopRequested: false })).toBe(false);
    expect(shouldResumeIdleWaitAfterWatch({ once: false, stopRequested: true })).toBe(false);
  });

  it("holds R keypress after terminal proposal-ready until review opens or quit", () => {
    expect(
      shouldHoldWatchForReviewKeypress({
        terminal: true,
        reviewHandoffPrinted: true,
        reviewable: true,
        reviewOpened: false,
        once: false,
        stopRequested: false
      })
    ).toBe(true);
    expect(
      shouldHoldWatchForReviewKeypress({
        terminal: true,
        reviewHandoffPrinted: true,
        reviewable: true,
        reviewOpened: true,
        once: false,
        stopRequested: false
      })
    ).toBe(false);
    expect(
      shouldHoldWatchForReviewKeypress({
        terminal: true,
        reviewHandoffPrinted: true,
        reviewable: true,
        reviewOpened: false,
        once: false,
        stopRequested: true
      })
    ).toBe(false);
    expect(
      shouldHoldWatchForReviewKeypress({
        terminal: false,
        reviewHandoffPrinted: true,
        reviewable: true,
        reviewOpened: false
      })
    ).toBe(false);
  });

  it("releases review hold when other active PairMesh work arrives", () => {
    expect(
      shouldReleaseWatchReviewHoldForOtherWork({
        holdingForReview: true,
        otherActiveCount: 0
      })
    ).toBe(false);
    expect(
      shouldReleaseWatchReviewHoldForOtherWork({
        holdingForReview: true,
        otherActiveCount: 1
      })
    ).toBe(true);
    expect(
      shouldReleaseWatchReviewHoldForOtherWork({
        holdingForReview: false,
        otherActiveCount: 2
      })
    ).toBe(false);
    expect(formatWatchLeavingReviewHoldForNewWork()).toBe(
      "New PairMesh work arrived — leaving review hold."
    );
    expect(watchUxContainsOpaqueWorkId(formatWatchLeavingReviewHoldForNewWork())).toBe(false);
  });
});
