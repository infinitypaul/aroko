import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ACTIVITY_VISIBILITY,
  ProgressEventSchema,
  ProviderMessageAggregator,
  appendProgressEvent,
  buildLifecycleProviderEventId,
  filterProgressEventsForViewer,
  projectProgressEventForRequester,
  resolveProgressVisibility,
  sanitizeProgressSafeMetadata,
  type ProgressEvent
} from "@pairmesh/protocol";
import { mapProviderActivityToProgressEvent } from "../action/provider-activity.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";
import { FakeCodingAgentAdapter } from "./fake-adapter.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

/** Stage 17 Prompt 2 — deterministic propose activity golden (unchanged). */
export const FAKE_PROPOSE_ACTIVITY_GOLDEN_KINDS = [
  "worker.started",
  "file.read",
  "search.started",
  "search.completed",
  "file.read",
  "proposal.preparing",
  "proposal.ready",
  "worker.completed"
] as const;

/** Stage 19 Prompt 2 — deterministic inspect reference timeline. */
export const FAKE_INSPECT_ACTIVITY_GOLDEN_KINDS = [
  "worker.started",
  "provider.message",
  "search.started",
  "search.completed",
  "file.read",
  "file.read",
  "tool.started",
  "tool.in_progress",
  "tool.completed",
  "finding",
  "command.started",
  "command.completed",
  "test.started",
  "test.completed",
  "worker.completed"
] as const;

const FIXED_TS = "2026-08-31T18:00:00.000Z";

function toProgress(
  operationId: string,
  events: readonly ProviderActivityEvent[]
): ProgressEvent[] {
  let progress: ProgressEvent[] = [];
  for (const event of events) {
    progress = appendProgressEvent(
      progress,
      mapProviderActivityToProgressEvent({
        actionId: operationId,
        event,
        timestamp: FIXED_TS
      })
    );
  }
  return progress;
}

describe("Stage 17 — fake provider rich activity golden", () => {
  it("emits the deterministic propose activity timeline", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const events: ProviderActivityEvent[] = [];
    await adapter.proposeChange(
      {
        requestId: "req_fake_golden",
        instruction: "Preserve original payment reference in retry rebuild."
      },
      {
        onProviderActivity: (event) => {
          events.push(event);
        }
      }
    );

    expect(events.map((event) => event.activityKind)).toEqual([
      ...FAKE_PROPOSE_ACTIVITY_GOLDEN_KINDS
    ]);
    expect(events[1]?.safeMetadata?.relativePath).toBe("src/retry.ts");
    expect(events[2]?.safeMetadata?.query).toBe("retryRecord.reference");
    expect(events[4]?.safeMetadata?.relativePath).toBe("src/payment.ts");
    expect(events.every((event) => event.providerEventId)).toBe(true);
    expect(new Set(events.map((event) => event.providerEventId)).size).toBe(events.length);
  });
});

describe("Stage 19 Prompt 2 — Fake inspect golden + ProgressEvent contract", () => {
  it("A/G/I/L — normalizes Fake inspect activity into canonical ProgressEvents", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const activity: ProviderActivityEvent[] = [];
    await adapter.inspect(
      {
        requestId: "req_s19_inspect",
        question: "Where is paymentReference mapped in the payment response?"
      },
      {
        onProviderActivity: (event) => {
          activity.push(event);
        }
      }
    );

    expect(activity.map((event) => event.activityKind)).toEqual([
      ...FAKE_INSPECT_ACTIVITY_GOLDEN_KINDS
    ]);
    expect(activity.every((event) => event.providerEventId)).toBe(true);
    expect(new Set(activity.map((e) => e.providerEventId)).size).toBe(activity.length);

    const progress = toProgress("req_s19_inspect", activity);
    expect(progress.map((e) => e.activityKind)).toEqual([...FAKE_INSPECT_ACTIVITY_GOLDEN_KINDS]);

    const message = progress.find((e) => e.activityKind === "provider.message");
    expect(message?.message).toBe("I'll inspect the payment flow.");
    expect(message?.visibility).toBe("requester_safe");
    expect(DEFAULT_ACTIVITY_VISIBILITY["provider.message"]).toBe("requester_safe");

    const toolStarted = progress.find((e) => e.activityKind === "tool.started");
    const toolProgress = progress.find((e) => e.activityKind === "tool.in_progress");
    const toolDone = progress.find((e) => e.activityKind === "tool.completed");
    expect(toolStarted?.safeMetadata?.toolStatus).toBe("pending");
    expect(toolProgress?.safeMetadata?.toolStatus).toBe("in_progress");
    expect(toolDone?.safeMetadata?.toolStatus).toBe("completed");
    expect(toolStarted?.visibility).toBe("owner_only");

    const finding = progress.find((e) => e.activityKind === "finding");
    expect(finding?.message).toBe("Retry handling appears relevant.");
    expect(finding?.visibility).toBe("requester_safe");

    const tests = progress.find((e) => e.activityKind === "test.completed");
    expect(tests?.safeMetadata?.passed).toBe(14);
    expect(tests?.safeMetadata?.failed).toBe(0);

    for (const event of progress) {
      expect(() => ProgressEventSchema.parse(event)).not.toThrow();
    }
  });

  it("B — sequence is monotonic and deterministic after append", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const activity: ProviderActivityEvent[] = [];
    await adapter.inspect(
      { requestId: "req_s19_seq", question: "payment fields in response" },
      { onProviderActivity: (e) => activity.push(e) }
    );
    const progress = toProgress("req_s19_seq", activity);
    const sequences = progress.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.slice().sort((a, b) => (a ?? 0) - (b ?? 0)));
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe((sequences[i - 1] ?? 0) + 1);
    }
  });

  it("C — duplicate providerEventId / lifecycle id does not append twice", () => {
    const startedId = buildLifecycleProviderEventId({
      nativeId: "tool_abc",
      transition: "started",
      prefix: "fake"
    });
    const inProgressId = buildLifecycleProviderEventId({
      nativeId: "tool_abc",
      transition: "in_progress",
      prefix: "fake"
    });
    expect(startedId).toBe("fake:tool_abc:started");
    expect(inProgressId).toBe("fake:tool_abc:in_progress");

    let events: ProgressEvent[] = [];
    const base = {
      operationId: "req_dedupe",
      phase: "reading_searching" as const,
      visibility: "owner_only" as const,
      timestamp: FIXED_TS,
      activityKind: "tool.started" as const,
      providerEventId: startedId
    };
    events = appendProgressEvent(events, base);
    events = appendProgressEvent(events, { ...base, message: "duplicate" });
    events = appendProgressEvent(events, {
      ...base,
      activityKind: "tool.in_progress",
      providerEventId: inProgressId
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.providerEventId)).toEqual([startedId, inProgressId]);
  });

  it("D — owner_only stays owner-only; requester_safe survives projection", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const activity: ProviderActivityEvent[] = [];
    await adapter.inspect(
      { requestId: "req_s19_vis", question: "payment fields in response" },
      { onProviderActivity: (e) => activity.push(e) }
    );
    const progress = toProgress("req_s19_vis", activity);
    const ownerDetail = progress.filter(
      (e) =>
        e.activityKind === "file.read" ||
        e.activityKind === "search.started" ||
        e.activityKind === "tool.started" ||
        e.activityKind === "command.started"
    );
    expect(ownerDetail.every((e) => e.visibility === "owner_only")).toBe(true);

    const requester = filterProgressEventsForViewer(progress, "requester");
    expect(requester.every((e) => e.visibility === "requester_safe")).toBe(true);
    expect(requester.some((e) => e.activityKind === "file.read")).toBe(false);
    expect(requester.some((e) => e.activityKind === "provider.message")).toBe(true);
    expect(JSON.stringify(requester)).not.toContain("src/payment.ts");
    expect(JSON.stringify(requester)).not.toContain("retryRecord.reference");
  });

  it("E/H — sanitization strips forbidden CoT / secret keys", () => {
    const sanitized = sanitizeProgressSafeMetadata({
      relativePath: "src/payment.ts",
      thinking: "private",
      reasoning: "private",
      chainOfThought: "private",
      stdout: "dump",
      authorization: "Bearer x",
      cookie: "sid=1",
      toolName: "Read"
    } as Record<string, unknown>);
    expect(sanitized).toEqual({ relativePath: "src/payment.ts", toolName: "Read" });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /thinking|reasoning|chainOfThought|stdout|Bearer|cookie/i
    );

    expect(() =>
      ProgressEventSchema.parse({
        operationId: "req_1",
        phase: "investigating",
        visibility: "owner_only",
        timestamp: FIXED_TS,
        thinking: "nope"
      })
    ).toThrow();
  });

  it("F — absolute and escaping paths rejected", () => {
    expect(
      sanitizeProgressSafeMetadata({ relativePath: "/Users/secret/repo/src/a.ts" } as Record<
        string,
        unknown
      >)
    ).toBeUndefined();
    expect(
      sanitizeProgressSafeMetadata({ relativePath: "../secrets" } as Record<string, unknown>)
    ).toBeUndefined();
    expect(
      sanitizeProgressSafeMetadata({ relativePath: "~/code/x.ts" } as Record<string, unknown>)
    ).toBeUndefined();
  });

  it("J — incomplete provider metadata still yields a representable event", () => {
    const event = mapProviderActivityToProgressEvent({
      actionId: "req_incomplete",
      timestamp: FIXED_TS,
      event: {
        phase: "reading_searching",
        activityKind: "tool.started",
        message: "Tool started.",
        providerEventId: "tool_no_input:started",
        safeMetadata: { provider: "fake", toolStatus: "pending" }
      }
    });
    expect(event.activityKind).toBe("tool.started");
    expect(event.safeMetadata?.query).toBeUndefined();
    expect(event.safeMetadata?.relativePath).toBeUndefined();
    expect(event.safeMetadata?.toolStatus).toBe("pending");
    expect(resolveProgressVisibility({ activityKind: "search.started" })).toBe("owner_only");

    const searchWithoutQuery = mapProviderActivityToProgressEvent({
      actionId: "req_incomplete",
      timestamp: FIXED_TS,
      event: {
        phase: "reading_searching",
        activityKind: "search.started",
        message: "Searching repository.",
        providerEventId: "search_bare:started",
        safeMetadata: { provider: "fake", toolKind: "search" }
      }
    });
    expect(searchWithoutQuery.activityKind).toBe("search.started");
    expect(searchWithoutQuery.message).toBe("Searching repository.");
  });

  it("K — terminal completed / failed / cancelled remain unambiguous", () => {
    const completed = mapProviderActivityToProgressEvent({
      actionId: "req_term",
      timestamp: FIXED_TS,
      event: {
        phase: "completed",
        activityKind: "worker.completed",
        visibility: "requester_safe",
        providerEventId: "done"
      }
    });
    const failed = mapProviderActivityToProgressEvent({
      actionId: "req_term",
      timestamp: FIXED_TS,
      event: {
        phase: "failed",
        activityKind: "worker.failed",
        visibility: "requester_safe",
        providerEventId: "fail"
      }
    });
    const cancelled = mapProviderActivityToProgressEvent({
      actionId: "req_term",
      timestamp: FIXED_TS,
      event: {
        phase: "cancelled",
        activityKind: "worker.cancelled",
        visibility: "requester_safe",
        providerEventId: "cancel"
      }
    });
    expect(completed.phase).toBe("completed");
    expect(failed.phase).toBe("failed");
    expect(cancelled.phase).toBe("cancelled");
    expect(new Set([completed.phase, failed.phase, cancelled.phase]).size).toBe(3);
  });

  it("high-frequency chunks aggregate to bounded provider.message events", () => {
    const aggregator = new ProviderMessageAggregator({ maxChars: 280, maxChunks: 64 });
    const chunks = [
      "I'll",
      " inspect",
      " the",
      " payment",
      " flow.",
      " Then",
      " I",
      " will",
      " summarize."
    ];
    // Simulate hundreds of tiny deltas (Prompt 1A-scale frequency).
    const tiny: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      tiny.push(i % 2 === 0 ? "a" : "b");
    }
    tiny.push(". ");

    const flushes: string[] = [];
    for (const chunk of [...chunks, ...tiny, "Final note."]) {
      const flush = aggregator.push(chunk);
      if (flush?.text) {
        flushes.push(flush.text);
      }
    }
    const trailing = aggregator.flush();
    if (trailing?.text) {
      flushes.push(trailing.text);
    }

    expect(flushes.length).toBeGreaterThan(0);
    expect(flushes.length).toBeLessThan(40);
    expect(flushes.some((text) => text.includes("I'll inspect the payment flow."))).toBe(true);

    let progress: ProgressEvent[] = [];
    for (let i = 0; i < flushes.length; i += 1) {
      progress = appendProgressEvent(progress, {
        operationId: "req_agg",
        phase: "investigating",
        visibility: "requester_safe",
        timestamp: FIXED_TS,
        activityKind: "provider.message",
        message: flushes[i],
        providerEventId: `msg:${i}`
      });
    }
    expect(progress).toHaveLength(flushes.length);
    expect(progress.length).toBeLessThan(400);
    const projected = projectProgressEventForRequester(progress[0]!);
    expect(projected?.activityKind).toBe("provider.message");
  });
});
