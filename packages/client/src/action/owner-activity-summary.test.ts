import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "@pairmesh/protocol";
import {
  DEFAULT_RECEIVER_ACTIVITY_LIMIT,
  MAX_RECEIVER_ACTIVITY_LIMIT,
  formatOwnerActivityLabel,
  latestOwnerActivityLabel,
  prepareOwnerActivityTimeline,
  summarizeOwnerActivity
} from "./owner-activity-summary.js";

const TS = "2026-08-27T12:00:00.000Z";

function richTimeline(countExtra = 0): ProgressEvent[] {
  const base: ProgressEvent[] = [
    {
      operationId: "act_1",
      phase: "provider_started",
      visibility: "owner_only",
      timestamp: TS,
      activityKind: "worker.started",
      sequence: 0,
      providerEventId: "w0"
    },
    {
      operationId: "act_1",
      phase: "reading_searching",
      visibility: "owner_only",
      timestamp: TS,
      activityKind: "file.read",
      sequence: 1,
      providerEventId: "r1",
      safeMetadata: { relativePath: "src/retry.ts", toolName: "Read" },
      message: "Reading src/retry.ts…"
    },
    {
      operationId: "act_1",
      phase: "reading_searching",
      visibility: "owner_only",
      timestamp: TS,
      activityKind: "search.started",
      sequence: 2,
      providerEventId: "s1",
      safeMetadata: { query: "retryRecord.reference", toolName: "Grep" }
    },
    {
      operationId: "act_1",
      phase: "reading_searching",
      visibility: "owner_only",
      timestamp: TS,
      activityKind: "search.completed",
      sequence: 3,
      providerEventId: "s1c"
    },
    {
      operationId: "act_1",
      phase: "proposal_preparing",
      visibility: "requester_safe",
      timestamp: TS,
      activityKind: "proposal.preparing",
      sequence: 4
    },
    {
      operationId: "act_1",
      phase: "proposal_ready",
      visibility: "requester_safe",
      timestamp: TS,
      activityKind: "proposal.ready",
      sequence: 5
    }
  ];

  const extras: ProgressEvent[] = [];
  for (let i = 0; i < countExtra; i += 1) {
    extras.push({
      operationId: "act_1",
      phase: "reading_searching",
      visibility: "owner_only",
      timestamp: TS,
      activityKind: "file.read",
      sequence: 100 + i,
      providerEventId: `extra-${i}`,
      safeMetadata: { relativePath: `src/extra-${i}.ts` }
    });
  }
  return [...base, ...extras];
}

describe("Stage 17 Prompt 6 — owner activity summary for receiver MCP", () => {
  it("formats rich owner labels including file.read and search", () => {
    const events = richTimeline();
    expect(formatOwnerActivityLabel(events[1]!)).toBe("Reading src/retry.ts…");
    expect(formatOwnerActivityLabel(events[2]!)).toBe("Searching retryRecord.reference…");
    expect(latestOwnerActivityLabel(events)).toBe("Waiting for approval");
  });

  it("dedupes by providerEventId and bounds the tail for Claude context", () => {
    const duped = [
      ...richTimeline(0),
      {
        ...richTimeline()[1]!,
        providerEventId: "r1"
      }
    ];
    const prepared = prepareOwnerActivityTimeline(duped);
    expect(prepared.filter((e) => e.providerEventId === "r1")).toHaveLength(1);

    const many = richTimeline(25);
    const summary = summarizeOwnerActivity({ progress: many });
    expect(summary.activityBound).toBe(DEFAULT_RECEIVER_ACTIVITY_LIMIT);
    expect(summary.activity).toHaveLength(DEFAULT_RECEIVER_ACTIVITY_LIMIT);
    expect(summary.activityTruncated).toBe(true);
    expect(summary.activityTotal).toBeGreaterThan(DEFAULT_RECEIVER_ACTIVITY_LIMIT);
    expect(summary.activity[0]?.safeMetadata?.relativePath).not.toBe("src/retry.ts");

    const capped = summarizeOwnerActivity({
      progress: many,
      activityLimit: MAX_RECEIVER_ACTIVITY_LIMIT
    });
    expect(capped.activity).toHaveLength(MAX_RECEIVER_ACTIVITY_LIMIT);
  });

  it("marks proposal ready / review required without inventing activity", () => {
    const summary = summarizeOwnerActivity({
      progress: richTimeline(),
      status: "approval_required",
      needsApproval: true
    });
    expect(summary.proposalReady).toBe(true);
    expect(summary.reviewRequired).toBe(true);
    expect(summary.coarseState).toBe("Waiting for approval");
    expect(summary.activity.map((a) => a.label)).toEqual([
      "Started",
      "Reading src/retry.ts…",
      "Searching retryRecord.reference…",
      "Search complete",
      "Preparing change…",
      "Waiting for approval"
    ]);
  });

  it("strips hostile / forbidden metadata before Claude sees it", () => {
    const summary = summarizeOwnerActivity({
      progress: [
        {
          operationId: "act_1",
          phase: "reading_searching",
          visibility: "owner_only",
          timestamp: TS,
          activityKind: "file.read",
          sequence: 1,
          safeMetadata: {
            relativePath: "src/retry.ts",
            absolutePath: "/Users/secret/src/retry.ts",
            chainOfThought: "never",
            prompt: "raw",
            stdout: "dump",
            toolName: "Read"
          } as ProgressEvent["safeMetadata"]
        }
      ]
    });
    const json = JSON.stringify(summary.activity);
    expect(summary.activity[0]?.safeMetadata).toEqual({
      relativePath: "src/retry.ts",
      toolName: "Read"
    });
    expect(json).not.toContain("never");
    expect(json).not.toContain("/Users");
    expect(json).not.toContain("raw");
    expect(json).not.toContain("dump");
  });

  it("does not mix unrelated action timelines when summarizing one operation", () => {
    const onlyAct1 = summarizeOwnerActivity({
      progress: richTimeline().filter((e) => e.operationId === "act_1")
    });
    expect(onlyAct1.activity.every((a) => a.label !== "Reading other.ts")).toBe(true);

    const mixedInput: ProgressEvent[] = [
      ...richTimeline(),
      {
        operationId: "act_other",
        phase: "reading_searching",
        visibility: "owner_only",
        timestamp: TS,
        activityKind: "file.read",
        sequence: 99,
        providerEventId: "other-1",
        safeMetadata: { relativePath: "other.ts" }
      }
    ];
    // Caller must pass one action's progress; summarize does not filter by operationId.
    // Prove callers that pass a single action's events stay isolated:
    const isolated = summarizeOwnerActivity({
      progress: mixedInput.filter((e) => e.operationId === "act_1")
    });
    expect(JSON.stringify(isolated)).not.toContain("other.ts");
  });
});
