import { describe, expect, it } from "vitest";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { PAIRMESH_METADATA_VERSION, type ProgressEvent } from "@pairmesh/protocol";
import { encodePairMeshInspectProgress } from "../a2a/inspection-messages.js";
import { extractInspectProgressFromTask } from "../a2a/task-lifecycle.js";
import { mergeRequesterInspectProgress } from "./requester-progress.js";

const TS = "2026-09-01T12:00:00.000Z";
const THOUGHT = "PRIVATE_COT_MUST_NEVER_CROSS_A2A";

function safeEvent(
  partial: Partial<ProgressEvent> & Pick<ProgressEvent, "phase" | "sequence">
): ProgressEvent {
  return {
    operationId: "req_live",
    visibility: "requester_safe",
    timestamp: TS,
    ...partial
  };
}

describe("Stage 19 Prompt 6 — requester inspect progress transport", () => {
  it("encodes progress on the wire without owner paths or private thought", () => {
    const events: ProgressEvent[] = [
      safeEvent({
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Claude started.",
        sequence: 1
      }),
      safeEvent({
        phase: "investigating",
        activityKind: "provider.message",
        message: "I'll trace the callback flow.",
        sequence: 2
      }),
      safeEvent({
        phase: "reading_searching",
        message: "Inspecting relevant code.",
        sequence: 3
      })
    ];
    const message = encodePairMeshInspectProgress({
      metadataVersion: PAIRMESH_METADATA_VERSION,
      requestId: "req_live",
      latestSequence: 3,
      events
    });
    const body = JSON.stringify(message);
    expect(body).toContain("pairmesh.inspect.progress");
    expect(body).not.toContain(THOUGHT);
    expect(body).not.toContain("/Users/");
    expect(body).not.toContain("src/private");

    const task: Task = {
      id: "task_1",
      contextId: "ctx",
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: { ...message, role: Role.ROLE_AGENT, contextId: "ctx", taskId: "task_1" },
        timestamp: TS
      },
      history: [],
      artifacts: [],
      metadata: undefined
    };
    const extracted = extractInspectProgressFromTask(task);
    expect(extracted?.events).toHaveLength(3);
    expect(extracted?.latestSequence).toBe(3);
  });

  it("dedupes repeated polls by sequence and never stores owner detail", () => {
    const firstBatch = [
      safeEvent({
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Claude started.",
        sequence: 1
      }),
      safeEvent({
        phase: "investigating",
        activityKind: "provider.message",
        message: "I'll trace the callback flow.",
        sequence: 2
      })
    ];
    let merged = mergeRequesterInspectProgress(undefined, firstBatch);
    expect(merged).toHaveLength(2);

    merged = mergeRequesterInspectProgress(merged, firstBatch);
    expect(merged).toHaveLength(2);

    const secondBatch = [
      ...firstBatch,
      safeEvent({
        phase: "reading_searching",
        message: "Searching repository.",
        sequence: 3
      }),
      // Hostile owner-only sneaked onto wire — re-projection must drop it.
      {
        operationId: "req_live",
        phase: "reading_searching",
        visibility: "owner_only" as const,
        timestamp: TS,
        activityKind: "file.read" as const,
        message: "Reading src/private/payment.ts",
        safeMetadata: { relativePath: "src/private/payment.ts" },
        sequence: 4
      }
    ];
    merged = mergeRequesterInspectProgress(merged, secondBatch);
    expect(merged.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(merged.some((e) => e.message === "Searching repository.")).toBe(true);
    expect(merged.some((e) => e.message === "Inspecting relevant code.")).toBe(true);
    expect(JSON.stringify(merged)).not.toContain("src/private");
    expect(JSON.stringify(merged)).not.toContain(THOUGHT);
  });

  it("proves requester can accumulate rich progress before a terminal event", () => {
    let requester: ProgressEvent[] = [];
    let remoteEnded = false;
    const midFlight = [
      safeEvent({
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Claude started.",
        sequence: 1
      }),
      safeEvent({
        phase: "investigating",
        activityKind: "provider.message",
        message: "I'll inspect ProgressEvent visibility filtering.",
        sequence: 2
      })
    ];
    requester = mergeRequesterInspectProgress(requester, midFlight);
    const requesterRichBeforeRemoteEnd =
      !remoteEnded &&
      requester.some((e) => e.activityKind === "worker.started") &&
      requester.some(
        (e) => e.activityKind === "provider.message" || e.message?.includes("inspect")
      );
    expect(requesterRichBeforeRemoteEnd).toBe(true);

    remoteEnded = true;
    requester = mergeRequesterInspectProgress(requester, [
      ...midFlight,
      safeEvent({
        phase: "completed",
        activityKind: "worker.completed",
        message: "Completed.",
        sequence: 3
      })
    ]);
    expect(requester.at(-1)?.phase).toBe("completed");
    expect(requester).toHaveLength(3);
  });

  it("handles malformed / unknown future kinds without throwing", () => {
    const weird = [
      {
        operationId: "req_live",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: TS,
        activityKind: "provider.message",
        message: "Safe narration.",
        sequence: 1,
        // @ts-expect-error intentional unknown future field on wire DTO
        futureKind: "galaxy.brain"
      } as ProgressEvent
    ];
    expect(() => mergeRequesterInspectProgress([], weird)).not.toThrow();
    expect(mergeRequesterInspectProgress([], undefined)).toEqual([]);
  });
});
