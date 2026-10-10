
import { formatActivityLabel, prepareProgressTimeline } from "./activity-present.js";
import { personDisplayName } from "./home-present.js";
import { formatElapsed } from "./live-present.js";

export const HISTORY_RETENTION_NOTE =
  "History is stored locally and may be limited by Aroko's local retention.";

export const HISTORY_PROVIDER_UNAVAILABLE = "Agent information unavailable";

export const HISTORY_WORK_CATEGORIES = {
  question: "Question",
  proposal: "Code proposal",
  change: "Code change",
  tests: "Tests",
  goal: "Goal"
};

const TERMINAL_INSPECTION = new Set(["completed", "failed", "timed_out", "cancelled"]);
const TERMINAL_ACTION = new Set([
  "completed",
  "denied",
  "cancelled",
  "failed",
  "expired",
  "unknown_outcome",
  "partially_completed"
]);
const TERMINAL_COLLABORATIVE_TASK = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function workItemKey(kind, id) {
  if (!kind || !id) return null;
  return `${kind}:${id}`;
}

function updatedAtMs(item) {
  const ms = Date.parse(item?.updatedAt ?? item?.createdAt ?? item?.completedAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

export function isHistoryInspection(item) {
  if (!item || item.kind !== "inspection") return false;
  if (item.terminal === false) return false;
  return TERMINAL_INSPECTION.has(String(item.status ?? ""));
}

export function isHistoryAction(item) {
  if (!item || item.kind !== "action") return false;
  if (item.terminal === false) return false;
  return TERMINAL_ACTION.has(String(item.status ?? ""));
}

export function isHistoryCollaborativeTask(item) {
  if (!item || (item.kind !== "collaborative_task" && !item.taskId)) return false;
  if (item.terminal === false) return false;
  return TERMINAL_COLLABORATIVE_TASK.has(String(item.status ?? ""));
}

export function mergeHistoryItems(input) {
  const inspections = (Array.isArray(input?.inspections) ? input.inspections : [])
    .filter((row) => row?.terminal !== false && TERMINAL_INSPECTION.has(String(row?.status ?? "")))
    .map((inspection) => ({
      ...inspection,
      kind: "inspection",
      id: inspection.requestId,
      workKey: workItemKey("inspection", inspection.requestId)
    }));
  const actions = (Array.isArray(input?.actions) ? input.actions : [])
    .filter((row) => row?.terminal !== false && TERMINAL_ACTION.has(String(row?.status ?? "")))
    .map((action) => ({
      ...action,
      kind: "action",
      id: action.actionId,
      workKey: workItemKey("action", action.actionId)
    }));
  const seenTaskIds = new Set();
  const tasks = (Array.isArray(input?.tasks) ? input.tasks : [])
    .filter((row) => {
      const status = String(row?.status ?? "");
      if (row?.terminal === false) return false;
      return TERMINAL_COLLABORATIVE_TASK.has(status) || row?.terminal === true;
    })
    .map((task) => {
      const taskId = task.taskId ?? task.id;
      return {
        ...task,
        kind: "collaborative_task",
        id: taskId,
        workKey: workItemKey("collaborative_task", taskId)
      };
    })
    .filter((task) => {
      if (!task.id || seenTaskIds.has(task.id)) return false;
      seenTaskIds.add(task.id);
      return true;
    });
  return [...inspections, ...actions, ...tasks].sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
}

export function historyWorkCategory(item) {
  if (!item) return "Work";
  if (item.kind === "inspection") return HISTORY_WORK_CATEGORIES.question;
  if (item.kind === "collaborative_task") return HISTORY_WORK_CATEGORIES.goal;
  if (item.actionType === "change.propose") return HISTORY_WORK_CATEGORIES.proposal;
  if (item.actionType === "repository.edit") return HISTORY_WORK_CATEGORIES.change;
  if (item.actionType === "tests.run") return HISTORY_WORK_CATEGORIES.tests;
  if (item.actionType === "process.execute") return HISTORY_WORK_CATEGORIES.tests;
  return "Request";
}

export function historyCategoryFilter(item, filter) {
  if (!filter || filter === "all") return true;
  const cat = historyWorkCategory(item);
  if (filter === "question") return cat === HISTORY_WORK_CATEGORIES.question;
  if (filter === "change") {
    return cat === HISTORY_WORK_CATEGORIES.change || cat === HISTORY_WORK_CATEGORIES.proposal;
  }
  if (filter === "tests") return cat === HISTORY_WORK_CATEGORIES.tests;
  return true;
}

export function resolveHistoryProvider(item) {
  if (typeof item?.providerDisplayName === "string" && item.providerDisplayName.trim()) {
    return item.providerDisplayName.trim();
  }
  if (typeof item?.executionProviderId === "string" && item.executionProviderId.trim()) {
    return item.executionProviderId.trim();
  }
  return null;
}

export function humanTerminalStatus(item) {
  const status = String(item?.status ?? "");
  if (item?.kind === "collaborative_task") {
    if (status === "completed") return "Completed";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    if (status === "timed_out") return "Timed out";
    return status.replace(/_/g, " ");
  }
  if (item?.kind === "inspection") {
    if (status === "completed") return "Completed";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    if (status === "timed_out") return "Timed out";
    return status.replace(/_/g, " ");
  }
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "denied") return "Denied";
  if (status === "expired") return "Expired";
  if (status === "partially_completed") return "Partially completed";
  if (status === "unknown_outcome") return "Unknown outcome";
  return status.replace(/_/g, " ");
}

export function historyDuration(item) {
  const start = item?.executionStartedAt ?? item?.startedAt ?? item?.createdAt;
  const end = item?.completedAt ?? (item?.terminal ? item?.updatedAt : null);
  return formatElapsed(start, end);
}

export function formatHistoryWhen(iso, now = new Date()) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWhen = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startOfToday - startOfWhen) / 86400000);
  if (dayDelta === 0) return `Today, ${time}`;
  if (dayDelta === 1) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function historyDateGroup(iso, now = new Date()) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "Earlier";
  const date = new Date(ms);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWhen = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startOfToday - startOfWhen) / 86400000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  return "Earlier";
}

export function groupHistoryItems(items, now = new Date()) {
  const groups = new Map();
  for (const item of items) {
    const label = historyDateGroup(item.updatedAt ?? item.completedAt ?? item.createdAt, now);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const order = ["Today", "Yesterday", "Earlier"];
  return order
    .filter((label) => groups.has(label))
    .map((label) => ({ label, items: groups.get(label) }));
}

export function buildHistoryCardModel(item) {
  if (!item) return null;
  if (item.kind === "collaborative_task") {
    const requester =
      (typeof item.requester?.displayName === "string" && item.requester.displayName.trim()) ||
      "Someone";
    const owner =
      (typeof item.owner?.displayName === "string" && item.owner.displayName.trim()) || "owner";
    const provider = resolveHistoryProvider(item);
    const status = humanTerminalStatus(item);
    const duration = historyDuration(item);
    const when = formatHistoryWhen(
      item.updatedAt ?? item.completedAt ?? item.createdAt ?? item.startedAt
    );
    const resultBit =
      typeof item.resultSummary === "string" && item.resultSummary.trim()
        ? item.resultSummary.trim()
        : typeof item.failureSummary === "string" && item.failureSummary.trim()
          ? item.failureSummary.trim()
          : "";
    let statusLine = status;
    if (provider) statusLine = `${provider} · ${status}`;
    if (duration) statusLine = `${statusLine} · ${duration}`;
    if (resultBit) statusLine = `${statusLine} · ${resultBit}`;
    return {
      workKey: item.workKey,
      kind: "collaborative_task",
      id: item.id ?? item.taskId,
      who: `${requester} → ${owner}`,
      headline: `${requester} → ${owner}`,
      question: String(item.goalSummary ?? item.originalGoal ?? "").trim(),
      workType: historyWorkCategory(item),
      statusLine,
      whenLabel: when ?? "",
      decisionHint: "",
      providerLabel: provider
    };
  }
  const who = personDisplayName(item.peer);
  const provider = resolveHistoryProvider(item);
  const question =
    item.kind === "inspection"
      ? (item.question ?? item.requestSummary ?? "")
      : item.actionType === "process.execute"
        ? (item.processExecution?.commandDisplay ??
          item.requestSummary ??
          item.summary ??
          item.actionLabel ??
          item.outputs?.commandDisplay ??
          "")
        : (item.requestSummary ?? item.summary ?? item.actionLabel ?? "");
  const status = humanTerminalStatus(item);
  const duration = historyDuration(item);
  const when = formatHistoryWhen(item.updatedAt ?? item.completedAt ?? item.createdAt);
  const workType = historyWorkCategory(item);
  let statusLine = status;
  if (provider) statusLine = `${provider} · ${status}`;
  if (duration) statusLine = `${statusLine} · ${duration}`;
  let decisionHint = "";
  if (
    item.kind === "action" &&
    item.actionType === "repository.edit" &&
    item.status === "completed"
  ) {
    decisionHint = "Approved once";
  } else if (item.status === "denied") {
    decisionHint = "Denied";
  }
  return {
    workKey: item.workKey,
    kind: item.kind,
    id: item.id,
    who,
    headline: `${who} → your agent`,
    question: String(question).trim(),
    workType,
    statusLine,
    whenLabel: when ?? "",
    decisionHint,
    providerLabel: provider
  };
}

export function buildHistoryEmptyCopy() {
  return {
    title: "No collaboration history yet.",
    detail: "Questions, changes, and tests handled through Aroko will appear here.",
    retention: HISTORY_RETENTION_NOTE
  };
}

export function humanDecisionLabel(item) {
  if (!item || item.kind !== "action") return null;
  const status = String(item.status ?? "");
  if (status === "denied") return "Denied";
  if (status === "expired") return "Expired";
  if (item.actionType === "repository.edit" && (status === "completed" || status === "executing")) {
    return "Approved once";
  }
  if (status === "completed" && item.approvedAt) return "Approved once";
  if (status === "completed") return "Completed";
  return null;
}

export function summarizeTestHistory(outputs) {
  if (!outputs || typeof outputs !== "object") return null;
  const profile =
    typeof outputs.profileName === "string" && outputs.profileName.trim()
      ? outputs.profileName.trim()
      : null;
  if (outputs.testPassed === true) {
    return profile ? `Tests passed (${profile})` : "Tests passed";
  }
  if (outputs.testPassed === false) {
    return profile ? `Tests failed (${profile})` : "Tests failed";
  }
  if (profile) return `Test profile: ${profile}`;
  return "Run one of your configured test profiles";
}

export function buildHistoryDetailSections(item) {
  if (item?.kind === "collaborative_task") {
    const requester =
      (typeof item.requester?.displayName === "string" && item.requester.displayName.trim()) ||
      "Someone";
    const owner =
      (typeof item.owner?.displayName === "string" && item.owner.displayName.trim()) || "owner";
    const provider = resolveHistoryProvider(item) ?? HISTORY_PROVIDER_UNAVAILABLE;
    const when = formatHistoryWhen(
      item.updatedAt ?? item.completedAt ?? item.createdAt ?? item.startedAt
    );
    const duration = historyDuration(item);
    const status = humanTerminalStatus(item);
    const result = item.resultSummary ?? item.failureSummary ?? item.summary ?? null;
    return {
      who: `${requester} → ${owner}`,
      provider,
      providerUnavailable: !resolveHistoryProvider(item),
      request: String(item.goalSummary ?? item.originalGoal ?? "").trim(),
      whenLabel: when,
      durationLabel: duration,
      status,
      decision: null,
      tests: null,
      result,
      error: item.failureSummary && !item.resultSummary ? item.failureSummary : null,
      timelineLabels: collaborativeTaskTimelineLabels(item),
      technical: {
        id: item.id ?? item.taskId,
        kind: "collaborative_task",
        status: item.status,
        createdAt: item.createdAt ?? item.startedAt,
        completedAt: item.completedAt
      }
    };
  }
  const who = personDisplayName(item?.peer);
  const provider = resolveHistoryProvider(item) ?? HISTORY_PROVIDER_UNAVAILABLE;
  const request =
    item?.kind === "inspection"
      ? (item?.question ?? "")
      : (item?.requestSummary ?? item?.summary ?? item?.actionLabel ?? "");
  const when = formatHistoryWhen(item?.updatedAt ?? item?.completedAt ?? item?.createdAt);
  const duration = historyDuration(item);
  const status = humanTerminalStatus(item);
  const decision = humanDecisionLabel(item);
  const tests = item?.kind === "action" ? summarizeTestHistory(item.outputs) : null;
  const result =
    item?.kind === "inspection"
      ? (item?.summary ?? item?.message ?? null)
      : (item?.summary ?? item?.message ?? item?.result?.summary ?? null);
  const error =
    item?.error?.message ??
    (typeof item?.outputs?.errorMessage === "string" ? item.outputs.errorMessage : null);
  return {
    who,
    provider,
    providerUnavailable: !resolveHistoryProvider(item),
    request: String(request).trim(),
    whenLabel: when,
    durationLabel: duration,
    status,
    decision,
    tests,
    result,
    error,
    timelineLabels: null,
    technical: {
      id: item?.id ?? item?.actionId ?? item?.requestId,
      kind: item?.kind,
      status: item?.status,
      createdAt: item?.createdAt ?? item?.startedAt,
      completedAt: item?.completedAt,
      actionType: item?.actionType
    }
  };
}

export function collaborativeTaskTimelineLabels(item) {
  const timeline = Array.isArray(item?.timeline) ? item.timeline : [];
  return timeline
    .map((row) => (typeof row?.label === "string" ? row.label.trim() : ""))
    .filter(Boolean);
}

export function historyTimelineLabels(progress) {
  return prepareProgressTimeline(progress).map((event) => formatActivityLabel(event));
}

export function historyHtmlContainsForbiddenTech(html) {
  const text = String(html ?? "");
  return [
    /chainOfThought/i,
    /agent_thought_chunk/i,
    /absolutePath/i,
    /inviteSecret/i,
    /\bstdout\b/i,
    /\/Users\/[^<\s]+/,
    /\/home\/[^<\s]+/,
    /wss:\/\//i
  ].some((re) => re.test(text));
}

const HISTORY_DETAIL_HIDDEN = "Technical detail hidden for safety.";

export function sanitizeHistoryCardModel(card) {
  if (!card || typeof card !== "object") {
    return {
      headline: "History item",
      question: HISTORY_DETAIL_HIDDEN,
      workType: "History",
      statusLine: "",
      whenLabel: "",
      decisionHint: "",
      unsafeFieldsHidden: true
    };
  }
  const next = { ...card };
  let hidden = false;
  for (const key of [
    "headline",
    "question",
    "workType",
    "statusLine",
    "whenLabel",
    "decisionHint"
  ]) {
    const value = next[key];
    if (typeof value === "string" && historyHtmlContainsForbiddenTech(value)) {
      next[key] = key === "question" || key === "statusLine" ? HISTORY_DETAIL_HIDDEN : "";
      hidden = true;
    }
  }
  if (hidden) {
    next.unsafeFieldsHidden = true;
  }
  return next;
}

export function sanitizeHistoryDetailSections(sections) {
  if (!sections || typeof sections !== "object") {
    return {
      who: "History",
      request: HISTORY_DETAIL_HIDDEN,
      result: HISTORY_DETAIL_HIDDEN
    };
  }
  const next = { ...sections };
  for (const key of Object.keys(next)) {
    const value = next[key];
    if (typeof value === "string" && historyHtmlContainsForbiddenTech(value)) {
      next[key] = HISTORY_DETAIL_HIDDEN;
    } else if (Array.isArray(value)) {
      next[key] = value.map((entry) =>
        typeof entry === "string" && historyHtmlContainsForbiddenTech(entry)
          ? HISTORY_DETAIL_HIDDEN
          : entry
      );
    } else if (value && typeof value === "object") {
      const nested = { ...value };
      for (const nestedKey of Object.keys(nested)) {
        if (
          typeof nested[nestedKey] === "string" &&
          historyHtmlContainsForbiddenTech(nested[nestedKey])
        ) {
          nested[nestedKey] = HISTORY_DETAIL_HIDDEN;
        }
      }
      next[key] = nested;
    }
  }
  return next;
}

export function findHistoryItem(items, kind, id) {
  if (!Array.isArray(items) || !kind || !id) return null;
  return (
    items.find(
      (item) =>
        item.kind === kind &&
        (item.id === id ||
          item.actionId === id ||
          item.requestId === id ||
          item.permissionRequestId === id ||
          item.taskId === id ||
          item.inputRequestId === id)
    ) ?? null
  );
}
