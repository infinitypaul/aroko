import { describe, expect, it } from "vitest";
import {
  MAX_PROGRESS_EVENTS,
  PROGRESS_FORBIDDEN_METADATA_KEYS,
  ProgressEventSchema,
  activityKindToProgressPhase,
  appendProgressEvent,
  filterProgressEventsForViewer,
  latestProgressEvent,
  latestProgressSequence,
  progressEventsForReplay,
  projectInspectionProgressForRequester,
  projectProgressEventForRequester,
  resolveProgressVisibility,
  sanitizeProgressSafeMetadata,
  type ProgressEvent
} from "./progress-event.js";

describe("Stage 17 ProgressEvent activity contract", () => {
  it("parses rich activityKind + replay fields", () => {
    const event = ProgressEventSchema.parse({
      operationId: "act_1",
      phase: "reading_searching",
      visibility: "owner_only",
      timestamp: "2026-08-23T12:00:00.000Z",
      message: "Reading src/retry.ts",
      activityKind: "file.read",
      sequence: 3,
      providerEventId: "prov-1",
      safeMetadata: {
        relativePath: "src/retry.ts",
        toolName: "Read",
        provider: "fake"
      }
    });
    expect(event.activityKind).toBe("file.read");
    expect(event.sequence).toBe(3);
    expect(event.providerEventId).toBe("prov-1");
  });

  it("rejects chain-of-thought fields on the schema", () => {
    expect(() =>
      ProgressEventSchema.parse({
        operationId: "act_1",
        phase: "investigating",
        visibility: "owner_only",
        timestamp: "2026-08-23T12:00:00.000Z",
        chainOfThought: "secret reasoning"
      })
    ).toThrow();
  });

  it("load-migrates legacy safeMetadata actionType/status keys", () => {
    const event = ProgressEventSchema.parse({
      operationId: "act_1",
      phase: "request_received",
      visibility: "requester_safe",
      timestamp: "2026-08-23T12:00:00.000Z",
      message: "Request received.",
      safeMetadata: {
        actionType: "change.propose",
        status: "requested",
        provider: "claude-code"
      }
    });
    expect(event.safeMetadata).toEqual({ provider: "claude-code" });
    expect(JSON.stringify(event)).not.toContain("actionType");
    expect(JSON.stringify(event)).not.toContain('"status"');
  });

  it("maps activityKind to coarse ProgressPhase", () => {
    expect(activityKindToProgressPhase("worker.started")).toBe("provider_started");
    expect(activityKindToProgressPhase("provider.message")).toBe("investigating");
    expect(activityKindToProgressPhase("file.read")).toBe("reading_searching");
    expect(activityKindToProgressPhase("search.started")).toBe("reading_searching");
    expect(activityKindToProgressPhase("tool.in_progress")).toBe("reading_searching");
    expect(activityKindToProgressPhase("command.started")).toBe("reading_searching");
    expect(activityKindToProgressPhase("test.started")).toBe("running_named_tests");
    expect(activityKindToProgressPhase("finding")).toBe("investigating");
    expect(activityKindToProgressPhase("proposal.ready")).toBe("proposal_ready");
    expect(activityKindToProgressPhase("worker.failed")).toBe("failed");
    expect(activityKindToProgressPhase("worker.cancelled")).toBe("cancelled");
  });

  it("forces owner_only for file/search/tool/command kinds", () => {
    expect(
      resolveProgressVisibility({
        activityKind: "file.read",
        visibility: "requester_safe"
      })
    ).toBe("owner_only");
    expect(
      resolveProgressVisibility({
        activityKind: "command.started",
        visibility: "requester_safe"
      })
    ).toBe("owner_only");
    expect(
      resolveProgressVisibility({
        activityKind: "proposal.ready",
        visibility: "requester_safe"
      })
    ).toBe("requester_safe");
    expect(resolveProgressVisibility({ activityKind: "provider.message" })).toBe("requester_safe");
    expect(resolveProgressVisibility({ activityKind: "finding" })).toBe("requester_safe");
  });

  it("Stage 17 Prompt 5 — requester projection strips owner detail even when mis-tagged", () => {
    const hostile: ProgressEvent = {
      operationId: "act_1",
      phase: "reading_searching",
      visibility: "requester_safe",
      timestamp: "2026-08-23T12:00:00.000Z",
      activityKind: "file.read",
      message: "Reading src/retry.ts",
      safeMetadata: {
        relativePath: "src/retry.ts",
        query: "retryRecord.reference",
        toolName: "Read",
        provider: "claude-code",
        correlationId: "corr_secret"
      },
      providerEventId: "prov-leak"
    };
    expect(projectProgressEventForRequester(hostile)).toBeNull();

    const mistaggedSafeKind: ProgressEvent = {
      operationId: "act_1",
      phase: "proposal_preparing",
      visibility: "requester_safe",
      timestamp: "2026-08-23T12:00:00.000Z",
      activityKind: "proposal.preparing",
      message: "Reading src/payment.ts",
      safeMetadata: {
        relativePath: "src/payment.ts",
        query: "secret",
        toolName: "Grep",
        testProfile: "payment-retry",
        durationMs: 12,
        provider: "claude-code",
        correlationId: "corr"
      },
      providerEventId: "prov-2",
      sequence: 4
    };
    const projected = projectProgressEventForRequester(mistaggedSafeKind);
    expect(projected).not.toBeNull();
    expect(projected?.safeMetadata).toEqual({ testProfile: "payment-retry", durationMs: 12 });
    expect(projected?.message).toBeUndefined();
    expect(projected?.providerEventId).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("src/");
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("Grep");
    expect(JSON.stringify(projected)).not.toContain("prov-2");

    const filtered = filterProgressEventsForViewer(
      [
        hostile,
        mistaggedSafeKind,
        {
          operationId: "act_1",
          phase: "investigating",
          visibility: "owner_only",
          timestamp: "2026-08-23T12:00:00.000Z",
          message: "Owner only"
        }
      ],
      "requester"
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.phase).toBe("proposal_preparing");
  });

  it("sanitizes safeMetadata and strips forbidden keys", () => {
    const sanitized = sanitizeProgressSafeMetadata({
      relativePath: "src/retry.ts",
      query: "retryRecord.reference",
      chainOfThought: "never",
      reasoning: "never",
      absolutePath: "/Users/secret/repo/src/retry.ts",
      prompt: "raw",
      stdout: "dump",
      toolName: "Grep",
      durationMs: 12
    } as Record<string, unknown>);
    expect(sanitized).toEqual({
      relativePath: "src/retry.ts",
      query: "retryRecord.reference",
      toolName: "Grep",
      durationMs: 12
    });
    for (const key of PROGRESS_FORBIDDEN_METADATA_KEYS) {
      expect(sanitized && key in sanitized).toBe(false);
    }
  });

  it("rejects absolute and traversal relativePath values", () => {
    expect(
      sanitizeProgressSafeMetadata({ relativePath: "/etc/passwd" } as Record<string, unknown>)
    ).toBeUndefined();
    expect(
      sanitizeProgressSafeMetadata({ relativePath: "../secrets" } as Record<string, unknown>)
    ).toBeUndefined();
  });

  it("assigns sequence, dedupes providerEventId, and hard-bounds retention", () => {
    let events = undefined as ReturnType<typeof appendProgressEvent> | undefined;
    events = appendProgressEvent(events, {
      operationId: "act_1",
      phase: "provider_started",
      visibility: "requester_safe",
      timestamp: "2026-08-23T12:00:00.000Z",
      activityKind: "worker.started",
      providerEventId: "evt-start"
    });
    events = appendProgressEvent(events, {
      operationId: "act_1",
      phase: "provider_started",
      visibility: "requester_safe",
      timestamp: "2026-08-23T12:00:01.000Z",
      activityKind: "worker.started",
      providerEventId: "evt-start"
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(0);

    for (let i = 0; i < MAX_PROGRESS_EVENTS + 25; i += 1) {
      events = appendProgressEvent(events, {
        operationId: "act_1",
        phase: "executing",
        visibility: i % 2 === 0 ? "requester_safe" : "owner_only",
        timestamp: "2026-08-23T12:00:00.000Z",
        providerEventId: `evt-${i}`
      });
    }
    expect(events).toHaveLength(MAX_PROGRESS_EVENTS);
    expect(events[0]?.sequence).toBeLessThan(events[events.length - 1]?.sequence ?? 0);

    const requester = filterProgressEventsForViewer(events, "requester");
    expect(requester.every((e) => e.visibility === "requester_safe")).toBe(true);
    expect(requester.some((e) => e.visibility === "owner_only")).toBe(false);

    const replay = progressEventsForReplay(events, 10);
    expect(replay).toHaveLength(10);
    expect(latestProgressEvent(events)?.providerEventId).toBe(`evt-${MAX_PROGRESS_EVENTS + 24}`);
  });

  it("keeps coarse events valid without activityKind (honest degrade)", () => {
    const event = ProgressEventSchema.parse({
      operationId: "act_1",
      phase: "proposal_preparing",
      visibility: "owner_only",
      timestamp: "2026-08-23T12:00:00.000Z",
      message: "Preparing change proposal (read-only tools)."
    });
    expect(event.activityKind).toBeUndefined();
  });

  it("Stage 19 Prompt 6 — inspection projection coalesces owner detail and sanitizes provider.message", () => {
    const THOUGHT = "PRIVATE_COT_MUST_NEVER_CROSS_A2A";
    const ownerTape: ProgressEvent[] = [
      {
        operationId: "req_1",
        phase: "provider_started",
        visibility: "requester_safe",
        timestamp: "2026-09-01T12:00:00.000Z",
        activityKind: "worker.started",
        message: "Claude started.",
        sequence: 1
      },
      {
        operationId: "req_1",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: "2026-09-01T12:00:01.000Z",
        activityKind: "provider.message",
        message: "I'll trace the callback flow.",
        sequence: 2
      },
      {
        operationId: "req_1",
        phase: "reading_searching",
        visibility: "owner_only",
        timestamp: "2026-09-01T12:00:02.000Z",
        activityKind: "file.read",
        message: "Reading src/private/payment.ts",
        safeMetadata: { relativePath: "src/private/payment.ts" },
        sequence: 3
      },
      {
        operationId: "req_1",
        phase: "reading_searching",
        visibility: "owner_only",
        timestamp: "2026-09-01T12:00:03.000Z",
        activityKind: "file.read",
        message: "Reading /Users/kelvin/company/secret.ts",
        safeMetadata: { absolutePath: "/Users/kelvin/company/secret.ts" },
        sequence: 4
      },
      {
        operationId: "req_1",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: "2026-09-01T12:00:04.000Z",
        activityKind: "provider.message",
        message: `Reading /Users/kelvin/company/.env ${THOUGHT}`,
        sequence: 5
      },
      {
        operationId: "req_1",
        phase: "reading_searching",
        visibility: "owner_only",
        timestamp: "2026-09-01T12:00:05.000Z",
        activityKind: "search.started",
        message: "Searching for webhook",
        safeMetadata: { query: "webhook retry" },
        sequence: 6
      },
      {
        operationId: "req_1",
        phase: "completed",
        visibility: "requester_safe",
        timestamp: "2026-09-01T12:00:06.000Z",
        activityKind: "worker.completed",
        message: "Completed.",
        sequence: 7
      }
    ];

    const projected = projectInspectionProgressForRequester(ownerTape);
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain("src/private");
    expect(wire).not.toContain("/Users/kelvin");
    expect(wire).not.toContain(THOUGHT);
    expect(wire).not.toContain("webhook retry");
    expect(wire).not.toContain(".env");
    expect(projected.some((e) => e.message === "I'll trace the callback flow.")).toBe(true);
    expect(projected.some((e) => e.message === "Inspecting relevant code.")).toBe(true);
    expect(projected.some((e) => e.message === "Searching repository.")).toBe(true);
    expect(projected.filter((e) => e.message === "Inspecting relevant code.")).toHaveLength(1);
    expect(latestProgressSequence(ownerTape)).toBe(7);
  });

  it("redacts repo-relative paths from provider.message mid-flight progress", () => {
    const projected = projectInspectionProgressForRequester([
      {
        operationId: "req_path",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: "2026-09-01T12:00:00.000Z",
        activityKind: "provider.message",
        message:
          "## Summary Payment retry lives entirely in `src/retry.ts`, reached through src/payment-service.ts.",
        sequence: 14
      },
      {
        operationId: "req_path",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: "2026-09-01T12:00:01.000Z",
        activityKind: "provider.message",
        message: "<<<PAIR_MESH_SOURCE_REFERENCES>>>",
        sequence: 15
      }
    ]);
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain("src/retry.ts");
    expect(wire).not.toContain("src/payment-service.ts");
    expect(wire).not.toContain("PAIR_MESH_SOURCE_REFERENCES");
    expect(projected.some((e) => e.message?.includes("[path]"))).toBe(true);
  });
});
