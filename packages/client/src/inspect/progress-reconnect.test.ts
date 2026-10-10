import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "@pairmesh/protocol";
import { mergeRequesterInspectProgress } from "./requester-progress.js";

const TS = "2026-09-01T12:00:00.000Z";

/**
 * Status-boundary reconnect: requester already saw 1..2; after a transport
 * gap, a newer snapshot returns 1..4 (receiver kept working). Merge must
 * append only unseen sequences — no duplicates, terminal still lands once.
 */
describe("Stage 19 Prompt 6 — interruption / recovery at status boundary", () => {
  it("resumes unseen progress after simulated status gap without duplicates", () => {
    const beforeGap: ProgressEvent[] = [
      {
        operationId: "req_r",
        phase: "provider_started",
        visibility: "requester_safe",
        timestamp: TS,
        activityKind: "worker.started",
        message: "Claude started.",
        sequence: 1
      },
      {
        operationId: "req_r",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: TS,
        activityKind: "provider.message",
        message: "I'll inspect visibility filtering.",
        sequence: 2
      }
    ];

    let requester = mergeRequesterInspectProgress(undefined, beforeGap);
    expect(requester).toHaveLength(2);

    // Gap: GetTask fails (transport). Receiver continues locally to seq 4.
    const afterRecovery: ProgressEvent[] = [
      ...beforeGap,
      {
        operationId: "req_r",
        phase: "reading_searching",
        visibility: "requester_safe",
        timestamp: TS,
        message: "Searching repository.",
        sequence: 3
      },
      {
        operationId: "req_r",
        phase: "completed",
        visibility: "requester_safe",
        timestamp: TS,
        activityKind: "worker.completed",
        message: "Completed.",
        sequence: 4
      }
    ];

    requester = mergeRequesterInspectProgress(requester, afterRecovery);
    expect(requester.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(requester.filter((e) => e.sequence === 2)).toHaveLength(1);
    expect(requester.filter((e) => e.phase === "completed")).toHaveLength(1);

    // Idempotent re-poll of the same terminal snapshot
    requester = mergeRequesterInspectProgress(requester, afterRecovery);
    expect(requester).toHaveLength(4);
  });

  it("survives retention gap — missed mid events OK if terminal arrives", () => {
    const early: ProgressEvent[] = [
      {
        operationId: "req_r",
        phase: "provider_started",
        visibility: "requester_safe",
        timestamp: TS,
        activityKind: "worker.started",
        message: "Started.",
        sequence: 1
      }
    ];
    let requester = mergeRequesterInspectProgress(undefined, early);

    // Receiver evicted mid events; only high-water snapshot remains
    const lateSnapshot: ProgressEvent[] = [
      {
        operationId: "req_r",
        phase: "completed",
        visibility: "requester_safe",
        timestamp: TS,
        activityKind: "worker.completed",
        message: "Completed.",
        sequence: 40
      }
    ];
    requester = mergeRequesterInspectProgress(requester, lateSnapshot);
    expect(requester.map((e) => e.sequence)).toEqual([1, 40]);
    expect(requester.at(-1)?.phase).toBe("completed");
  });
});
