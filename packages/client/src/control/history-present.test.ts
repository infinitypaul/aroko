import { describe, expect, it } from "vitest";
import {
  buildHistoryCardModel,
  buildHistoryDetailSections,
  buildHistoryEmptyCopy,
  historyCategoryFilter,
  historyDateGroup,
  historyDuration,
  historyHtmlContainsForbiddenTech,
  historyTimelineLabels,
  historyWorkCategory,
  mergeHistoryItems,
  resolveHistoryProvider,
  sanitizeHistoryCardModel,
  sanitizeHistoryDetailSections
} from "../../control-web/history-present.js";

const kelvin = { displayName: "Kelvin", participantId: "peer_k" };

const completedInspection = {
  kind: "inspection",
  requestId: "insp_1",
  status: "completed",
  terminal: true,
  question: "Where is payment retry handled?",
  peer: kelvin,
  providerDisplayName: "Claude Code",
  executionProviderId: "claude-code",
  startedAt: "2026-09-01T10:00:00.000Z",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:54.000Z",
  completedAt: "2026-09-01T10:00:54.000Z",
  executionStartedAt: "2026-09-01T10:00:01.000Z",
  progress: [
    {
      operationId: "o",
      phase: "provider_started",
      activityKind: "worker.started",
      timestamp: "2026-09-01T10:00:01.000Z",
      sequence: 1
    },
    {
      operationId: "o",
      phase: "reading_searching",
      activityKind: "file.read",
      timestamp: "2026-09-01T10:00:02.000Z",
      sequence: 2,
      safeMetadata: { relativePath: "src/retry.ts" }
    }
  ],
  summary: "Payment retry is handled in src/retry.ts"
};

const completedEdit = {
  kind: "action",
  actionId: "act_1",
  status: "completed",
  actionType: "repository.edit",
  actionLabel: "Apply change",
  terminal: true,
  peer: { displayName: "Sarah" },
  providerDisplayName: "Claude Code",
  requestSummary: "Add validation before creating the payment",
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:05:00.000Z",
  completedAt: "2026-09-01T09:05:00.000Z",
  executionStartedAt: "2026-09-01T09:00:10.000Z",
  progress: []
};

describe("Stage 20 Prompt 5 — History presentation", () => {
  it("merges terminal inspections and actions newest-first", () => {
    const merged = mergeHistoryItems({
      inspections: [completedInspection],
      actions: [completedEdit]
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.kind).toBe("inspection");
    expect(merged[1]?.kind).toBe("action");
  });

  it("merges terminal collaborative tasks and builds goal history cards", () => {
    const task = {
      taskId: "task_hist",
      status: "completed",
      terminal: true,
      goalSummary: "Install the payments package",
      requester: { displayName: "Kelvin" },
      owner: { displayName: "Paul" },
      providerDisplayName: "Claude Code",
      resultSummary: "Package installed",
      createdAt: "2026-09-01T08:00:00.000Z",
      startedAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:10:00.000Z",
      completedAt: "2026-09-01T08:10:00.000Z",
      timeline: [
        { label: "Goal started", at: "2026-09-01T08:00:00.000Z" },
        { label: "Requester answered", at: "2026-09-01T08:05:00.000Z" },
        { label: "Task completed", at: "2026-09-01T08:10:00.000Z" }
      ]
    };
    const merged = mergeHistoryItems({
      inspections: [],
      actions: [],
      tasks: [task, { ...task, taskId: "task_hist" }]
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("collaborative_task");
    expect(historyWorkCategory(merged[0]!)).toBe("Goal");
    const card = buildHistoryCardModel(merged[0]!);
    expect(card?.headline).toBe("Kelvin → Paul");
    expect(card?.question).toMatch(/Install the payments package/i);
    expect(card?.statusLine).toMatch(/Completed/);
    const detail = buildHistoryDetailSections(merged[0]!);
    expect(detail.timelineLabels).toEqual(["Goal started", "Requester answered", "Task completed"]);
  });

  it("uses human work categories", () => {
    expect(historyWorkCategory({ kind: "inspection" })).toBe("Question");
    expect(historyWorkCategory({ kind: "action", actionType: "change.propose" })).toBe(
      "Code proposal"
    );
    expect(historyWorkCategory({ kind: "action", actionType: "repository.edit" })).toBe(
      "Code change"
    );
    expect(historyWorkCategory({ kind: "action", actionType: "tests.run" })).toBe("Tests");
  });

  it("builds cards with provider, status, duration, and when", () => {
    const card = buildHistoryCardModel(completedInspection);
    expect(card?.headline).toContain("Kelvin");
    expect(card?.statusLine).toContain("Claude Code");
    expect(card?.statusLine).toMatch(/Completed/);
    expect(card?.whenLabel).toMatch(/Today|Yesterday|Sep/);
    expect(historyDuration(completedInspection)).toMatch(/\d+s/);
  });

  it("does not use current provider when snapshot missing", () => {
    expect(resolveHistoryProvider({ providerDisplayName: "Claude Code" })).toBe("Claude Code");
    expect(resolveHistoryProvider({ executionProviderId: "claude-code" })).toBe("claude-code");
    expect(resolveHistoryProvider({})).toBeNull();
  });

  it("builds detail sections with timeline and result", () => {
    const detail = buildHistoryDetailSections(completedInspection);
    expect(detail.who).toBe("Kelvin");
    expect(detail.request).toMatch(/payment retry/i);
    expect(detail.provider).toBe("Claude Code");
    expect(detail.result).toMatch(/Payment retry/i);
    const labels = historyTimelineLabels(completedInspection.progress);
    expect(labels.some((l) => /Reading src\/retry\.ts/i.test(l))).toBe(true);
    expect(historyHtmlContainsForbiddenTech(`${labels.join(" ")} /Users/secret`)).toBe(true);
  });

  it("filters categories locally", () => {
    expect(historyCategoryFilter(completedInspection, "question")).toBe(true);
    expect(historyCategoryFilter(completedEdit, "question")).toBe(false);
    expect(historyCategoryFilter(completedEdit, "change")).toBe(true);
  });

  it("groups by Today/Yesterday/Earlier", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    expect(historyDateGroup("2026-09-01T10:00:00.000Z", now)).toBe("Today");
    expect(historyDateGroup("2026-08-31T10:00:00.000Z", now)).toBe("Yesterday");
    expect(historyDateGroup("2026-08-01T10:00:00.000Z", now)).toBe("Earlier");
  });

  it("provides calm empty copy with retention honesty", () => {
    const empty = buildHistoryEmptyCopy();
    expect(empty.title).toMatch(/No collaboration history/i);
    expect(empty.retention).toMatch(/stored locally/i);
  });

  it("S20-M3: sanitizes stdout in one card without echoing the token", () => {
    const bad = buildHistoryCardModel({
      kind: "collaborative_task",
      taskId: "task_1",
      id: "task_1",
      status: "completed",
      goalSummary: "Run node --version",
      resultSummary: "Reported stdout: v25.6.1",
      requester: { displayName: "Paul" },
      owner: { displayName: "Kelvin" },
      createdAt: "2026-09-12T03:00:00.000Z",
      updatedAt: "2026-09-12T03:00:10.000Z",
      completedAt: "2026-09-12T03:00:10.000Z"
    });
    expect(historyHtmlContainsForbiddenTech(bad.statusLine)).toBe(true);
    const safe = sanitizeHistoryCardModel(bad);
    expect(safe.statusLine).toBe("Technical detail hidden for safety.");
    expect(safe.statusLine).not.toMatch(/stdout/i);
    expect(safe.question).toMatch(/node/);
    expect(safe.unsafeFieldsHidden).toBe(true);
  });

  it("S20-M3: good cards stay intact when another would be unsafe", () => {
    const good = sanitizeHistoryCardModel(buildHistoryCardModel(completedInspection));
    const bad = sanitizeHistoryCardModel(
      buildHistoryCardModel({
        kind: "collaborative_task",
        taskId: "task_bad",
        id: "task_bad",
        status: "completed",
        goalSummary: "goal",
        resultSummary: "stdout leaked",
        requester: { displayName: "Paul" },
        owner: { displayName: "Kelvin" },
        createdAt: "2026-09-12T03:00:00.000Z",
        updatedAt: "2026-09-12T03:00:10.000Z"
      })
    );
    expect(good.question).toMatch(/payment retry/i);
    expect(historyHtmlContainsForbiddenTech(good.question)).toBe(false);
    expect(bad.statusLine).toBe("Technical detail hidden for safety.");
  });

  it("S20-M3: detail sanitize redacts forbidden fields without secret echo", () => {
    const sections = sanitizeHistoryDetailSections({
      who: "Kelvin",
      request: "ok question",
      result: "stdout: v25.6.1",
      technical: { id: "task_1", status: "completed" }
    });
    expect(sections.request).toBe("ok question");
    expect(sections.result).toBe("Technical detail hidden for safety.");
    expect(JSON.stringify(sections)).not.toMatch(/\bstdout\b/i);
  });

  it("S20-M3: XSS payloads stay data (escape is caller's job; sanitize does not inject HTML)", () => {
    const safe = sanitizeHistoryCardModel({
      headline: "<script>alert(1)</script>",
      question: "<img src=x onerror=alert(1)>",
      workType: "Goal",
      statusLine: "ok",
      whenLabel: "",
      decisionHint: ""
    });
    expect(safe.headline).toContain("<script>");
    expect(safe.question).toContain("<img");
    expect(historyHtmlContainsForbiddenTech(safe.headline)).toBe(false);
  });
});
