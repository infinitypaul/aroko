import { describe, expect, it } from "vitest";
import {
  mapInspectionProgressToProgressEvent,
  mapInspectionProgressToProviderActivity,
  mapProviderActivityToProgressEvent
} from "./provider-activity.js";

describe("Stage 17 — provider activity → ProgressEvent", () => {
  it("maps owner-only tool activity with safe metadata and activityKind", () => {
    const event = mapProviderActivityToProgressEvent({
      actionId: "act_test",
      timestamp: "2026-08-23T12:00:00.000Z",
      event: {
        phase: "reading_searching",
        activityKind: "file.read",
        message: "Reading src/retry.ts",
        visibility: "requester_safe",
        providerEventId: "read-1",
        safeMetadata: {
          relativePath: "src/retry.ts",
          chainOfThought: "nope"
        } as never
      }
    });
    expect(event.phase).toBe("reading_searching");
    expect(event.activityKind).toBe("file.read");
    expect(event.visibility).toBe("owner_only");
    expect(event.safeMetadata).toEqual({ relativePath: "src/retry.ts" });
    expect(event.providerEventId).toBe("read-1");
    expect(event).not.toHaveProperty("chainOfThought");
  });

  it("honors requester_safe visibility for non-detail kinds", () => {
    const event = mapProviderActivityToProgressEvent({
      actionId: "act_test",
      timestamp: "2026-08-23T12:00:00.000Z",
      event: {
        phase: "provider_started",
        activityKind: "worker.started",
        visibility: "requester_safe",
        message: "Worker started."
      }
    });
    expect(event.visibility).toBe("requester_safe");
    expect(event.activityKind).toBe("worker.started");
  });

  it("maps coarse events without activityKind (Claude-style degrade)", () => {
    const event = mapProviderActivityToProgressEvent({
      actionId: "act_test",
      timestamp: "2026-08-23T12:00:00.000Z",
      event: {
        phase: "proposal_preparing",
        message: "Preparing change proposal (read-only tools)."
      }
    });
    expect(event.phase).toBe("proposal_preparing");
    expect(event.activityKind).toBeUndefined();
    expect(event.visibility).toBe("owner_only");
  });
});

describe("Stage 17 — inspect progress convergence", () => {
  it("maps InspectionProgressEvent into canonical ProgressEvent", () => {
    const event = mapInspectionProgressToProgressEvent({
      operationId: "insp_1",
      timestamp: "2026-08-23T12:00:00.000Z",
      event: {
        phase: "coding-agent-starting",
        message: "Starting coding agent.",
        elapsedMs: 5
      },
      providerEventId: "insp-start"
    });
    expect(event.phase).toBe("provider_started");
    expect(event.activityKind).toBe("worker.started");
    expect(event.visibility).toBe("requester_safe");
    expect(event.safeMetadata?.durationMs).toBe(5);
    expect(event.providerEventId).toBe("insp-start");
  });

  it("maps inspect failure to worker.failed", () => {
    const event = mapInspectionProgressToProgressEvent({
      operationId: "insp_1",
      timestamp: "2026-08-23T12:00:00.000Z",
      event: { phase: "failed", message: "Inspection failed." }
    });
    expect(event.activityKind).toBe("worker.failed");
    expect(event.phase).toBe("failed");
  });

  it("bridges InspectionProgressEvent to ProviderActivityEvent", () => {
    const activity = mapInspectionProgressToProviderActivity({
      phase: "inspecting",
      message: "Inspecting repository."
    });
    expect(activity.phase).toBe("investigating");
    expect(activity.activityKind).toBeUndefined();
    expect(activity.visibility).toBe("requester_safe");
  });
});
