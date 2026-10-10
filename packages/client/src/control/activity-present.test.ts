import { describe, expect, it } from "vitest";
import {
  ACTIVITY_POLL_MS,
  DEFAULT_POLL_MS,
  MAX_PROGRESS_EVENTS,
  coarseStateLabel,
  formatActivityLabel,
  formatApprovedMetadataChips,
  isActionReviewable,
  prepareProgressTimeline,
  progressEventKey,
  resolvePollIntervalMs
} from "../../control-web/activity-present.js";

describe("Stage 17 Prompt 4 — Activity presentation", () => {
  it("renders activityKind into human language", () => {
    expect(formatActivityLabel({ activityKind: "worker.started" })).toBe("Started");
    expect(
      formatActivityLabel({
        activityKind: "file.read",
        safeMetadata: { relativePath: "src/retry.ts" }
      })
    ).toBe("Reading src/retry.ts…");
    expect(
      formatActivityLabel({
        activityKind: "search.started",
        safeMetadata: { query: "retryRecord.reference" }
      })
    ).toBe("Searching retryRecord.reference…");
    expect(formatActivityLabel({ activityKind: "search.completed" })).toBe("Search complete");
    expect(
      formatActivityLabel({
        activityKind: "tool.started",
        safeMetadata: { toolName: "Read" }
      })
    ).toBe("Using Read…");
    expect(
      formatActivityLabel({
        activityKind: "tool.completed",
        safeMetadata: { toolName: "Read" }
      })
    ).toBe("Read completed");
    expect(
      formatActivityLabel({
        activityKind: "test.started",
        safeMetadata: { testProfile: "payment-retry" }
      })
    ).toBe("Running payment-retry…");
    expect(formatActivityLabel({ activityKind: "proposal.preparing" })).toBe("Preparing change…");
    expect(formatActivityLabel({ activityKind: "proposal.ready" })).toBe("Waiting for approval");
    expect(formatActivityLabel({ activityKind: "worker.completed" })).toBe("Completed");
    expect(formatActivityLabel({ activityKind: "worker.failed" })).toBe("Failed");
  });

  it("falls back to coarse ProgressPhase when activityKind is absent", () => {
    expect(formatActivityLabel({ phase: "investigating" })).toBe("Investigating");
    expect(formatActivityLabel({ phase: "proposal_preparing" })).toBe("Preparing change…");
  });

  it("degrades safely for unknown activity kinds", () => {
    expect(
      formatActivityLabel({
        activityKind: "future.kind",
        message: "Something observable"
      })
    ).toBe("Something observable");
    expect(formatActivityLabel({ activityKind: "future.kind" })).toBe("future.kind");
  });

  it("dedupes reconnect replay by providerEventId / sequence and respects 200 bound", () => {
    const events = [
      {
        operationId: "act_1",
        phase: "provider_started",
        activityKind: "worker.started",
        providerEventId: "a",
        sequence: 0,
        timestamp: "2026-08-27T12:00:00.000Z"
      },
      {
        operationId: "act_1",
        phase: "provider_started",
        activityKind: "worker.started",
        providerEventId: "a",
        sequence: 0,
        timestamp: "2026-08-27T12:00:00.000Z"
      },
      {
        operationId: "act_1",
        phase: "reading_searching",
        activityKind: "file.read",
        providerEventId: "b",
        sequence: 1,
        timestamp: "2026-08-27T12:00:01.000Z",
        safeMetadata: { relativePath: "src/retry.ts" }
      }
    ];
    const prepared = prepareProgressTimeline(events);
    expect(prepared).toHaveLength(2);
    expect(prepared.map((e) => e.activityKind)).toEqual(["worker.started", "file.read"]);

    const many = Array.from({ length: MAX_PROGRESS_EVENTS + 25 }, (_, i) => ({
      operationId: "act_1",
      phase: "executing",
      sequence: i,
      providerEventId: `evt-${i}`,
      timestamp: "2026-08-27T12:00:00.000Z"
    }));
    const capped = prepareProgressTimeline(many);
    expect(capped).toHaveLength(MAX_PROGRESS_EVENTS);
    expect(capped[0]?.sequence).toBe(25);
    expect(progressEventKey(capped[0]!)).toBe("id:evt-25");
  });

  it("only surfaces approved metadata chips", () => {
    const chips = formatApprovedMetadataChips({
      relativePath: "src/retry.ts",
      query: "retryRecord.reference",
      toolName: "Grep",
      chainOfThought: "never",
      absolutePath: "/Users/secret",
      prompt: "raw",
      stdout: "dump",
      correlationId: "hidden-from-ui"
    } as Record<string, unknown>);
    expect(chips.map((c) => c.key).sort()).toEqual(["path", "query", "tool"]);
    expect(JSON.stringify(chips)).not.toContain("never");
    expect(JSON.stringify(chips)).not.toContain("/Users");
    expect(JSON.stringify(chips)).not.toContain("hidden-from-ui");
  });

  it("uses faster polling on Activity tab / running actions", () => {
    expect(resolvePollIntervalMs({ tab: "activity", actions: [] })).toBe(ACTIVITY_POLL_MS);
    expect(
      resolvePollIntervalMs({
        tab: "inbox",
        selectedAction: { status: "executing" }
      })
    ).toBe(ACTIVITY_POLL_MS);
    expect(resolvePollIntervalMs({ tab: "inbox", actions: [] })).toBe(DEFAULT_POLL_MS);
  });

  it("marks proposal-ready actions as reviewable without inventing approval", () => {
    expect(
      isActionReviewable({
        status: "executing",
        progress: [{ activityKind: "proposal.ready", phase: "proposal_ready" }]
      })
    ).toBe(true);
    expect(
      isActionReviewable({
        status: "approval_required",
        needsApproval: true,
        progress: []
      })
    ).toBe(true);
    expect(
      isActionReviewable({
        status: "executing",
        progress: [{ activityKind: "file.read", phase: "reading_searching" }]
      })
    ).toBe(false);
  });

  it("exposes coarse state for list rows", () => {
    expect(
      coarseStateLabel({
        status: "executing",
        latestProgress: {
          activityKind: "file.read",
          safeMetadata: { relativePath: "src/payment.ts" }
        }
      })
    ).toBe("Reading src/payment.ts…");
  });

  it("renders a Prompt-3-shaped timeline in sequence without fabricating steps", () => {
    const timeline = prepareProgressTimeline([
      {
        operationId: "act_demo",
        phase: "proposal_ready",
        activityKind: "proposal.ready",
        sequence: 6,
        providerEventId: "p6",
        timestamp: "2026-08-27T12:00:06.000Z"
      },
      {
        operationId: "act_demo",
        phase: "provider_started",
        activityKind: "worker.started",
        sequence: 0,
        providerEventId: "p0",
        timestamp: "2026-08-27T12:00:00.000Z"
      },
      {
        operationId: "act_demo",
        phase: "reading_searching",
        activityKind: "file.read",
        sequence: 1,
        providerEventId: "p1",
        timestamp: "2026-08-27T12:00:01.000Z",
        safeMetadata: { relativePath: "src/retry.ts" }
      },
      {
        operationId: "act_demo",
        phase: "reading_searching",
        activityKind: "search.started",
        sequence: 2,
        providerEventId: "p2",
        timestamp: "2026-08-27T12:00:02.000Z",
        safeMetadata: { query: "retryRecord.reference" }
      },
      {
        operationId: "act_demo",
        phase: "reading_searching",
        activityKind: "search.completed",
        sequence: 3,
        providerEventId: "p3",
        timestamp: "2026-08-27T12:00:03.000Z"
      },
      {
        operationId: "act_demo",
        phase: "reading_searching",
        activityKind: "file.read",
        sequence: 4,
        providerEventId: "p4",
        timestamp: "2026-08-27T12:00:04.000Z",
        safeMetadata: { relativePath: "src/payment.ts" }
      },
      {
        operationId: "act_demo",
        phase: "proposal_preparing",
        activityKind: "proposal.preparing",
        sequence: 5,
        providerEventId: "p5",
        timestamp: "2026-08-27T12:00:05.000Z"
      }
    ]);

    expect(timeline.map((e) => formatActivityLabel(e))).toEqual([
      "Started",
      "Reading src/retry.ts…",
      "Searching retryRecord.reference…",
      "Search complete",
      "Reading src/payment.ts…",
      "Preparing change…",
      "Waiting for approval"
    ]);
  });

  it("treats Activity poll as the live-update mechanism (no manual refresh)", () => {
    // Adaptive bounded polling: Activity tab always uses ACTIVITY_POLL_MS.
    // Reconnect = re-fetch + prepareProgressTimeline dedupe (no SSE required).
    expect(ACTIVITY_POLL_MS).toBe(1000);
    expect(DEFAULT_POLL_MS).toBe(3000);
    expect(ACTIVITY_POLL_MS).toBeLessThan(DEFAULT_POLL_MS);
  });

  it("uses live poll interval for Control Center live and home views", () => {
    expect(resolvePollIntervalMs({ tab: "live" })).toBe(ACTIVITY_POLL_MS);
    expect(resolvePollIntervalMs({ view: "home" })).toBe(ACTIVITY_POLL_MS);
    expect(resolvePollIntervalMs({ tab: "needs-you" })).toBe(DEFAULT_POLL_MS);
  });
});
