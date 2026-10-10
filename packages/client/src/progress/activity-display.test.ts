import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "@pairmesh/protocol";
import {
  buildActivityDisplayItems,
  formatActivityTimelineText,
  formatElapsedDuration,
  formatLifecycleHumanMessage,
  formatProgressActivityLabel
} from "./activity-display.js";

const TS = "2026-09-01T12:00:00.000Z";
const THOUGHT = "PRIVATE_COT_MUST_NEVER_CROSS_A2A";

function ev(
  partial: Partial<ProgressEvent> & Pick<ProgressEvent, "phase" | "sequence">
): ProgressEvent {
  return {
    operationId: "req_ux",
    visibility: "requester_safe",
    timestamp: TS,
    ...partial
  };
}

describe("Stage 19 Prompt 7 — activity display", () => {
  it("maps canonical kinds to human vocabulary", () => {
    expect(
      formatProgressActivityLabel(
        ev({ phase: "provider_started", activityKind: "worker.started", sequence: 1 }),
        "owner"
      )
    ).toBe("Started");
    expect(
      formatProgressActivityLabel(
        ev({
          phase: "investigating",
          activityKind: "provider.message",
          message: "I'll trace the callback flow.",
          sequence: 2
        }),
        "owner"
      )
    ).toBe("I'll trace the callback flow.");
    expect(
      formatProgressActivityLabel(
        ev({
          phase: "reading_searching",
          activityKind: "search.started",
          sequence: 3,
          visibility: "owner_only",
          safeMetadata: { query: "webhook" }
        }),
        "owner"
      )
    ).toBe("Searching webhook…");
    expect(
      formatProgressActivityLabel(
        ev({
          phase: "reading_searching",
          activityKind: "file.read",
          sequence: 4,
          visibility: "owner_only",
          safeMetadata: { relativePath: "src/payments/webhook.ts" }
        }),
        "owner"
      )
    ).toBe("Reading src/payments/webhook.ts…");
    expect(
      formatProgressActivityLabel(
        ev({
          phase: "running_named_tests",
          activityKind: "test.completed",
          sequence: 5,
          visibility: "owner_only",
          safeMetadata: { passed: 12, failed: 0 }
        }),
        "owner"
      )
    ).toBe("12 tests passed");
    expect(
      formatProgressActivityLabel(
        ev({
          phase: "running_named_tests",
          activityKind: "test.completed",
          sequence: 6,
          visibility: "owner_only",
          safeMetadata: { passed: 10, failed: 2 }
        }),
        "owner"
      )
    ).toBe("Tests failed (10 passed / 2 failed)");
    expect(
      formatProgressActivityLabel(
        ev({
          phase: "completed",
          activityKind: "worker.completed",
          sequence: 7,
          safeMetadata: { durationMs: 18_000 }
        }),
        "owner"
      )
    ).toBe("Completed in 18s");
  });

  it("does not let requester recover owner paths from hostile events", () => {
    const label = formatProgressActivityLabel(
      ev({
        phase: "reading_searching",
        activityKind: "file.read",
        sequence: 1,
        visibility: "owner_only",
        message: "Reading src/secret.ts",
        safeMetadata: { relativePath: "src/secret.ts" }
      }),
      "requester"
    );
    expect(label).toBe("Inspecting relevant code.");
    expect(label).not.toContain("src/");
  });

  it("suppresses repeated Investigating and redundant tool/search noise", () => {
    const events: ProgressEvent[] = [
      ev({ phase: "provider_started", activityKind: "worker.started", sequence: 1 }),
      ev({ phase: "investigating", sequence: 2 }),
      ev({ phase: "investigating", sequence: 3 }),
      ev({ phase: "investigating", sequence: 4 }),
      ev({
        phase: "reading_searching",
        activityKind: "search.started",
        sequence: 5,
        visibility: "owner_only",
        safeMetadata: { query: "retry" }
      }),
      ev({
        phase: "reading_searching",
        activityKind: "search.completed",
        sequence: 6,
        visibility: "owner_only"
      }),
      ev({
        phase: "reading_searching",
        activityKind: "tool.started",
        sequence: 7,
        visibility: "owner_only",
        safeMetadata: { toolName: "Read" }
      }),
      ev({
        phase: "reading_searching",
        activityKind: "tool.in_progress",
        sequence: 8,
        visibility: "owner_only",
        safeMetadata: { toolName: "Read" }
      }),
      ev({
        phase: "reading_searching",
        activityKind: "tool.completed",
        sequence: 9,
        visibility: "owner_only",
        safeMetadata: { toolName: "Read" }
      }),
      ev({
        phase: "investigating",
        activityKind: "provider.message",
        message: "First thought.",
        sequence: 10
      }),
      ev({
        phase: "investigating",
        activityKind: "provider.message",
        message: "Second thought.",
        sequence: 11
      }),
      ev({ phase: "completed", activityKind: "worker.completed", sequence: 12 })
    ];
    const items = buildActivityDisplayItems(events, "owner");
    const labels = items.map((i) => i.label);
    expect(labels.filter((l) => l === "Investigating")).toHaveLength(1);
    expect(labels).toContain("Searching retry…");
    expect(labels).not.toContain("Search complete");
    expect(labels.filter((l) => l.includes("Read"))).toHaveLength(1);
    expect(labels).toContain("First thought.");
    expect(labels).toContain("Second thought.");
    expect(labels.at(-1)).toBe("Completed");
  });

  it("suppresses duplicate generic inspect for requester", () => {
    const events = [
      ev({ phase: "provider_started", activityKind: "worker.started", sequence: 1 }),
      ev({ phase: "reading_searching", message: "Inspecting relevant code.", sequence: 2 }),
      ev({ phase: "reading_searching", message: "Inspecting relevant code.", sequence: 3 }),
      ev({ phase: "completed", activityKind: "worker.completed", sequence: 4 })
    ];
    const items = buildActivityDisplayItems(events, "requester");
    expect(items.filter((i) => i.label.includes("Inspecting"))).toHaveLength(1);
  });

  it("formats owner and requester snapshots differently without leaking paths", () => {
    const ownerTape: ProgressEvent[] = [
      ev({
        phase: "provider_started",
        activityKind: "worker.started",
        sequence: 1,
        visibility: "owner_only"
      }),
      ev({
        phase: "investigating",
        activityKind: "provider.message",
        message: "I'll trace the callback flow.",
        sequence: 2
      }),
      ev({
        phase: "reading_searching",
        activityKind: "search.started",
        sequence: 3,
        visibility: "owner_only",
        safeMetadata: { query: "payment callback" }
      }),
      ev({
        phase: "reading_searching",
        activityKind: "file.read",
        sequence: 4,
        visibility: "owner_only",
        safeMetadata: { relativePath: "src/payments/webhook.ts" }
      }),
      ev({
        phase: "investigating",
        activityKind: "finding",
        message: "retry handling",
        sequence: 5
      }),
      ev({
        phase: "completed",
        activityKind: "worker.completed",
        sequence: 6,
        safeMetadata: { durationMs: 18_000 }
      })
    ];

    const ownerText = formatActivityTimelineText({
      progress: ownerTape,
      viewer: "owner",
      header: "Paul → Claude Code",
      question: "Why can duplicate payment callbacks happen?"
    });

    expect(ownerText).toMatchInlineSnapshot(`
      "Paul → Claude Code

      "Why can duplicate payment callbacks happen?"

      ● Started
      ● "I'll trace the callback flow."
      ● Searching payment callback…
      ● Reading src/payments/webhook.ts…
      ● Found: retry handling
      ✓ Completed in 18s"
    `);

    const requesterTape: ProgressEvent[] = [
      ev({ phase: "provider_started", activityKind: "worker.started", sequence: 1 }),
      ev({
        phase: "investigating",
        activityKind: "provider.message",
        message: "I'll trace the callback flow.",
        sequence: 2
      }),
      ev({ phase: "reading_searching", message: "Searching repository.", sequence: 3 }),
      ev({ phase: "reading_searching", message: "Inspecting relevant code.", sequence: 4 }),
      ev({
        phase: "investigating",
        activityKind: "finding",
        message: "a likely cause",
        sequence: 5
      }),
      ev({
        phase: "completed",
        activityKind: "worker.completed",
        sequence: 6,
        safeMetadata: { durationMs: 18_000 }
      })
    ];

    const requesterText = formatActivityTimelineText({
      progress: requesterTape,
      viewer: "requester",
      header: "Kelvin — Claude Code"
    });

    expect(requesterText).toMatchInlineSnapshot(`
      "Kelvin — Claude Code

      ● Started
      ● "I'll trace the callback flow."
      ● Searching repository.
      ● Inspecting relevant code.
      ● Found: a likely cause
      ✓ Completed in 18s"
    `);

    expect(requesterText).not.toContain("src/");
    expect(requesterText).not.toContain("webhook");
    expect(requesterText).not.toContain(THOUGHT);
    expect(requesterText).not.toContain("/Users/");
  });

  it("keeps lifecycle messages distinct", () => {
    expect(
      formatLifecycleHumanMessage({
        lifecycle: "requester_wait_expired",
        peerLabel: "Kelvin",
        requestId: "req_123"
      })
    ).toContain("still working");
    expect(
      formatLifecycleHumanMessage({
        lifecycle: "requester_wait_expired",
        peerLabel: "Kelvin",
        requestId: "req_123"
      })
    ).not.toMatch(/failed/i);

    expect(
      formatLifecycleHumanMessage({
        lifecycle: "peer_transport_unavailable",
        peerLabel: "Kelvin",
        requestId: "req_123"
      })
    ).toContain("couldn't reach");

    expect(
      formatLifecycleHumanMessage({
        lifecycle: "failed",
        peerLabel: "Kelvin",
        elapsedMs: 12_000
      })
    ).toContain("failed after 12s");

    expect(
      formatLifecycleHumanMessage({
        lifecycle: "timed_out",
        peerLabel: "Kelvin",
        elapsedMs: 60_000
      })
    ).toContain("timed out after 1m");

    expect(
      formatLifecycleHumanMessage({
        lifecycle: "cancelled",
        peerLabel: "Kelvin"
      })
    ).toContain("cancelled");
  });

  it("formats elapsed duration for humans", () => {
    expect(formatElapsedDuration(500)).toBe("1s");
    expect(formatElapsedDuration(18_000)).toBe("18s");
    expect(formatElapsedDuration(65_000)).toBe("1m 5s");
  });

  it("never includes thought / absolute path / stdout in display labels", () => {
    const hostile = formatProgressActivityLabel(
      ev({
        phase: "investigating",
        activityKind: "provider.message",
        message: `Reading /Users/kelvin/secret.ts ${THOUGHT}`,
        sequence: 1
      }),
      "requester"
    );
    expect(hostile).not.toContain("/Users/");
    expect(hostile).not.toContain(THOUGHT);
  });
});
