
import {
  coarseStateLabel,
  formatActivityLabel,
  isActionActivelyRunning,
  prepareProgressTimeline,
  resolvePollIntervalMs
} from "./activity-present.js";
import { personDisplayName } from "./home-present.js";

const ACTIVE_INSPECTION_STATUSES = new Set(["pending", "running"]);
const ACTIVE_ACTION_STATUSES = new Set([
  "requested",
  "authenticating",
  "authorizing",
  "approved",
  "executing"
]);
const TERMINAL_INSPECTION_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled"]);
const TERMINAL_ACTION_STATUSES = new Set([
  "completed",
  "denied",
  "cancelled",
  "failed",
  "expired",
  "unknown_outcome",
  "partially_completed"
]);
const TERMINAL_COLLABORATIVE_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);

/** Human labels for capability-scoped Needs you decisions. */
export const CAPABILITY_APPROVAL_COPY = {
  "repository.inspect": {
    title: "wants to ask questions about your code",
    allowOnce: "Allow this question",
    deny: "Deny",
    helper: "This approves this request only. Persistent access is managed under People."
  },
  "repository.source_references": {
    title: "wants to receive file references",
    allowOnce: "Allow file references",
    deny: "Deny",
    helper: "This approves this request only. Paths stay repository-relative when allowed."
  },
  "change.propose": {
    title: "wants to propose a code change",
    allowOnce: "Allow proposal",
    deny: "Deny",
    helper:
      "Proposing a change does not modify your repository. Apply still needs separate approval."
  },
  "repository.edit": {
    title: "wants to apply a code change",
    allowOnce: "Approve once",
    deny: "Deny",
    helper:
      "If you approve, Aroko applies this exact reviewed change once (MODIFY / CREATE / DELETE / RENAME)."
  },
  "tests.run": {
    title: "wants to run your test profiles",
    allowOnce: "Allow this test request",
    deny: "Deny",
    helper: "Runs one of your configured test profiles — not arbitrary shell access."
  },
  "process.execute": {
    title: "wants to run a command",
    allowOnce: "Approve once",
    deny: "Deny",
    helper:
      "This command runs with your user privileges and may modify files, your repository, machine state, or external services."
  }
};

export function workItemKey(kind, id) {
  if (!kind || !id) return null;
  return `${kind}:${id}`;
}

export function parseWorkItemKey(key) {
  if (!key || typeof key !== "string") return null;
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return { kind: key.slice(0, idx), id: key.slice(idx + 1) };
}

export function isActiveInspection(inspection) {
  if (!inspection || inspection.terminal === true) return false;
  return ACTIVE_INSPECTION_STATUSES.has(String(inspection.status ?? ""));
}

export function isActiveLiveAction(action) {
  if (!action || action.terminal === true) return false;
  if (action.status === "approval_required") return false;
  return ACTIVE_ACTION_STATUSES.has(String(action.status ?? ""));
}

export function isActiveCollaborativeTask(task) {
  if (!task || task.terminal === true) return false;
  return !TERMINAL_COLLABORATIVE_TASK_STATUSES.has(String(task.status ?? ""));
}

export function isTerminalLiveStatus(kind, status) {
  const value = String(status ?? "");
  if (kind === "inspection") return TERMINAL_INSPECTION_STATUSES.has(value);
  if (kind === "collaborative_task") return TERMINAL_COLLABORATIVE_TASK_STATUSES.has(value);
  return TERMINAL_ACTION_STATUSES.has(value);
}

/** Human waiting hint for CollaborativeTask Live cards — never route health. */
export function collaborativeTaskWaitingHint(task) {
  const waitingOn = String(task?.waitingOn ?? "");
  if (waitingOn === "requester") return "Needs input";
  if (waitingOn === "owner") return "Waiting for approval";
  if (waitingOn === "provider") return task?.phaseLabel ?? "Working";
  if (
    typeof task?.waitingOnLabel === "string" &&
    task.waitingOnLabel.trim() &&
    waitingOn !== "none"
  ) {
    return task.waitingOnLabel.trim();
  }
  return task?.phaseLabel ?? "In progress";
}

export function formatElapsed(fromIso, toIso = null) {
  const start = Date.parse(fromIso ?? "");
  if (!Number.isFinite(start)) return null;
  const end = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${hours}h ${m}m` : `${hours}h`;
}

export function humanWorkType(item) {
  if (!item) return "Work";
  if (item.kind === "inspection") return "Question";
  if (item.kind === "collaborative_task") return "Goal";
  if (item.kind === "input_request") return "Answer needed";
  if (item.actionType === "repository.edit") return "Apply change";
  if (item.actionType === "change.propose") return "Propose change";
  if (item.actionType === "tests.run") return "Run tests";
  if (item.actionType === "process.execute") return "Run command";
  return item.actionLabel ?? "Request";
}

export function humanLiveStatus(item) {
  if (!item) return "Unknown";
  const status = String(item.status ?? "");
  if (item.kind === "collaborative_task") {
    if (typeof item.phaseLabel === "string" && item.phaseLabel.trim()) {
      return item.phaseLabel.trim();
    }
    if (status === "completed") return "Completed";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    if (status === "timed_out") return "Timed out";
    return status.replace(/_/g, " ") || "In progress";
  }
  if (item.kind === "inspection") {
    if (status === "running" || status === "pending") return "Working";
    if (status === "completed") return "Completed";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    if (status === "timed_out") return "Timed out";
    return status.replace(/_/g, " ");
  }
  if (status === "executing" || status === "approved") return "Working";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "denied") return "Denied";
  if (status === "expired") return "Expired";
  if (status === "partially_completed") return "Partially completed";
  return coarseStateLabel(item);
}

function latestUsefulLabel(item) {
  const progress = Array.isArray(item?.progress) ? item.progress : [];
  if (item?.latestProgress) {
    return formatActivityLabel(item.latestProgress);
  }
  const timeline = prepareProgressTimeline(progress);
  const last = timeline[timeline.length - 1];
  return last ? formatActivityLabel(last) : humanLiveStatus(item);
}

function updatedAtMs(item) {
  const ms = Date.parse(item?.updatedAt ?? item?.createdAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/** Merge active inspections + actions + collaborative tasks for Live (newest first). */
export function mergeLiveWorkItems(input) {
  const actions = (Array.isArray(input?.actions) ? input.actions : [])
    .filter(isActiveLiveAction)
    .map((action) => ({
      ...action,
      kind: "action",
      id: action.actionId,
      workKey: workItemKey("action", action.actionId)
    }));
  const inspections = (Array.isArray(input?.inspections) ? input.inspections : [])
    .filter(isActiveInspection)
    .map((inspection) => ({
      ...inspection,
      kind: "inspection",
      id: inspection.requestId,
      workKey: workItemKey("inspection", inspection.requestId),
      actionLabel: inspection.actionLabel ?? "Inspection"
    }));
  const tasks = (Array.isArray(input?.tasks) ? input.tasks : [])
    .filter(isActiveCollaborativeTask)
    .map((task) => {
      const taskId = task.taskId ?? task.id;
      return {
        ...task,
        kind: "collaborative_task",
        id: taskId,
        workKey: workItemKey("collaborative_task", taskId)
      };
    });
  return [...actions, ...inspections, ...tasks].sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
}

export function buildLiveCardModel(item, options = {}) {
  if (!item) return null;
  if (item.kind === "collaborative_task") {
    const requester =
      (typeof item.requester?.displayName === "string" && item.requester.displayName.trim()) ||
      "Someone";
    const owner =
      (typeof item.owner?.displayName === "string" && item.owner.displayName.trim()) || "owner";
    const provider = item.providerDisplayName ?? options.fallbackProvider ?? null;
    const phase = item.phaseLabel ?? humanLiveStatus(item);
    const phaseProvider = provider ? `${phase} · ${provider}` : phase;
    const waitingHint = collaborativeTaskWaitingHint(item);
    const elapsed = formatElapsed(item.createdAt, item.terminal ? item.completedAt : null);
    return {
      workKey: item.workKey ?? workItemKey("collaborative_task", item.id ?? item.taskId),
      kind: "collaborative_task",
      id: item.id ?? item.taskId,
      who: `${requester} → ${owner}`,
      provider: provider ?? "your coding agent",
      headline: `${requester} → ${owner}`,
      question: String(item.goalSummary ?? item.originalGoal ?? "").trim(),
      workType: humanWorkType(item),
      statusLabel: phase,
      recentActivity: waitingHint,
      elapsedLabel: elapsed ? `${phaseProvider} · ${elapsed}` : phaseProvider,
      live: !item.terminal && String(item.waitingOn ?? "") === "provider"
    };
  }
  const who = personDisplayName(item.peer);
  const provider = item.providerDisplayName ?? options.fallbackProvider ?? "your coding agent";
  const question =
    item.kind === "inspection"
      ? (item.question ?? item.requestSummary ?? "")
      : (item.requestSummary ?? item.summary ?? item.actionLabel ?? "");
  const elapsed = formatElapsed(item.createdAt, item.terminal ? item.completedAt : null);
  const statusLabel = humanLiveStatus(item);
  const recent = latestUsefulLabel(item);
  return {
    workKey: item.workKey ?? workItemKey(item.kind, item.id ?? item.actionId ?? item.requestId),
    kind: item.kind,
    id: item.id ?? item.actionId ?? item.requestId,
    who,
    provider,
    headline: `${who} → ${provider}`,
    question: String(question).trim(),
    workType: humanWorkType(item),
    statusLabel,
    recentActivity: recent,
    elapsedLabel: elapsed ? `${statusLabel} · ${elapsed}` : statusLabel,
    live: item.kind === "inspection" ? item.status === "running" : isActionActivelyRunning(item)
  };
}

export function buildLiveEmptyCopy() {
  return {
    title: "Nothing is running right now.",
    detail: "New work from people you've connected will appear here while your agent is working."
  };
}

/**
 * Needs you: pending actions + permissions + requester InputRequests.
 * InputRequests use Answer semantics — never Approve/Deny.
 */
export function mergeNeedsYouItems(input) {
  const actions = (Array.isArray(input?.actions) ? input.actions : []).filter(
    (action) => action?.status === "approval_required" || action?.needsApproval === true
  );
  const linkedPermissionIds = new Set();
  const linkedCorrelations = new Set();
  for (const action of actions) {
    if (action.permissionRequestId) linkedPermissionIds.add(action.permissionRequestId);
    if (action.actionId) linkedCorrelations.add(action.actionId);
  }

  const actionItems = actions.map((action) => ({
    ...action,
    kind: "action",
    id: action.actionId,
    workKey: workItemKey("action", action.actionId)
  }));

  const permissions = (Array.isArray(input?.permissions) ? input.permissions : []).filter(
    (pending) => {
      if (!pending || pending.status !== "pending") return false;
      if (linkedPermissionIds.has(pending.permissionRequestId)) return false;
      if (linkedCorrelations.has(pending.correlationRequestId)) return false;
      // Prefer the richer action card when a linked actionType is already pending.
      if (
        pending.actionType &&
        actions.some(
          (a) =>
            a.actionType === pending.actionType &&
            a.permissionRequestId === pending.permissionRequestId
        )
      ) {
        return false;
      }
      return true;
    }
  );

  const permissionItems = permissions.map((pending) => ({
    ...pending,
    kind: "permission",
    id: pending.permissionRequestId,
    workKey: workItemKey("permission", pending.permissionRequestId)
  }));

  const pendingInputs = (
    Array.isArray(input?.pendingInputs)
      ? input.pendingInputs
      : Array.isArray(input?.inputs)
        ? input.inputs
        : []
  ).filter((row) => row && (row.status === "pending" || !row.status));

  const inputItems = pendingInputs.map((row) => {
    const id = row.inputRequestId ?? row.id;
    return {
      ...row,
      kind: "input_request",
      id,
      workKey: workItemKey("input_request", id),
      interaction: "answer",
      collaborativeInteraction: "answer"
    };
  });

  return [...actionItems, ...permissionItems, ...inputItems].sort(
    (a, b) => updatedAtMs(b) - updatedAtMs(a)
  );
}

export function capabilityApprovalCopy(capabilityId) {
  return (
    CAPABILITY_APPROVAL_COPY[capabilityId] ?? {
      title: "needs your approval",
      allowOnce: "Allow this request",
      deny: "Deny",
      helper: "This approves this request only."
    }
  );
}

export function buildNeedsYouCardModel(item) {
  if (!item) return null;
  if (item.kind === "input_request") {
    const owner =
      (typeof item.owner?.displayName === "string" && item.owner.displayName.trim()) || "Someone";
    const question = String(item.question ?? "").trim();
    const goal =
      typeof item.goalSummary === "string" && item.goalSummary.trim()
        ? item.goalSummary.trim()
        : null;
    return {
      workKey: item.workKey,
      kind: "input_request",
      id: item.id ?? item.inputRequestId,
      who: owner,
      title: `${owner} needs your answer`,
      subtitle: question,
      helper: goal ? `About: ${goal}` : "Answer this question to continue the goal.",
      cta: "Answer",
      allowOnceLabel: "Answer",
      denyLabel: null,
      allowSession: false,
      interaction: "answer",
      collaborativeInteraction: "answer",
      question,
      cliHint: `aroko task answer ${item.id ?? item.inputRequestId} --text "…"`,
      taskId: item.taskId ?? null
    };
  }
  if (item.kind === "permission") {
    const who =
      (typeof item.displayName === "string" && item.displayName.trim()) ||
      (typeof item.peerName === "string" && item.peerName.trim()) ||
      "Someone";
    const copy = capabilityApprovalCopy(item.capabilityId);
    return {
      workKey: item.workKey,
      kind: "permission",
      id: item.id,
      who,
      title: `${who} ${copy.title}`,
      subtitle: copy.helper,
      cta: "Review",
      allowOnceLabel: copy.allowOnce,
      denyLabel: "Deny",
      // Needs you uses one-time decisions; persistent policy lives in People.
      // repository.edit never offers session allow.
      allowSession: false,
      capabilityId: item.capabilityId
    };
  }

  const who = personDisplayName(item.peer);
  let title = `${who}'s request needs your approval`;
  let helper = "Review and decide.";
  let allowOnceLabel = "Allow this request";
  if (item.actionType === "repository.edit") {
    title = `${who} wants to apply a code change`;
    helper =
      "If you approve, Aroko applies this exact reviewed change once (MODIFY / CREATE / DELETE / RENAME).";
    allowOnceLabel = "Approve once";
  } else if (item.actionType === "change.propose") {
    title = `${who} wants to propose a code change`;
    helper = "Proposing a change does not modify your repository.";
    allowOnceLabel = "Allow proposal";
  } else if (item.actionType === "tests.run") {
    title = `${who} wants to run your test profiles`;
    helper = "Runs one of your configured test profiles — not arbitrary shell access.";
    allowOnceLabel = "Allow this test request";
  } else if (item.actionType === "process.execute") {
    title = `${who} wants to run a command`;
    helper =
      "This command runs with your user privileges and may modify files, your repository, machine state, or external services.";
    allowOnceLabel = "Approve once";
  }
  const summary =
    item.actionType === "process.execute"
      ? item.processExecution?.commandDisplay ||
        item.requestSummary ||
        item.summary ||
        item.actionLabel ||
        ""
      : (item.requestSummary ?? item.summary ?? item.actionLabel ?? "");
  const provenance =
    typeof item.collaborativeProvenanceLabel === "string" &&
    item.collaborativeProvenanceLabel.trim()
      ? item.collaborativeProvenanceLabel.trim()
      : null;
  return {
    workKey: item.workKey,
    kind: "action",
    id: item.id,
    who,
    title,
    subtitle: summary,
    provenance,
    helper:
      item.actionType === "process.execute" && item.approvalUnavailableReason
        ? item.approvalUnavailableReason
        : helper,
    cta: "Review",
    allowOnceLabel,
    denyLabel: "Deny",
    allowSession: Boolean(
      item.canApproveSession &&
      item.actionType !== "repository.edit" &&
      item.capabilityId !== "repository.edit" &&
      item.actionType !== "process.execute" &&
      item.capabilityId !== "process.execute" &&
      !item.canApproveOnce
    ),
    actionType: item.actionType,
    canApproveOnce: Boolean(item.canApproveOnce),
    needsApproval: Boolean(item.needsApproval),
    collaborativeInteraction: item.collaborativeInteraction === "approve" ? "approve" : undefined,
    processDetails:
      item.actionType === "process.execute" && item.processExecution
        ? {
            commandDisplay: item.processExecution.commandDisplay,
            executable: item.processExecution.executable,
            args: Array.isArray(item.processExecution.args) ? item.processExecution.args : [],
            cwd: item.processExecution.cwd,
            timeoutMs: item.processExecution.timeoutMs
          }
        : item.actionType === "process.execute"
          ? null
          : null
  };
}

export function humanizeDecisionError(raw) {
  const text = String(raw ?? "");
  if (/not.?found|unknown/i.test(text)) {
    return "This request is no longer available. Aroko refreshed your list.";
  }
  if (/expired/i.test(text)) {
    return "This approval window expired. Nothing was applied.";
  }
  if (/already|resolved|invalid.?state|not.?pending/i.test(text)) {
    return "This request was already decided. Aroko refreshed your list.";
  }
  return "Aroko couldn't complete this decision. Nothing was changed.";
}

export function humanizeDecisionSuccess(decision, result) {
  const status = result?.status;
  if (decision === "deny" || status === "denied") {
    return { message: "Denied. No change was applied.", tone: "info" };
  }
  if (status === "expired") {
    return {
      message:
        "This approval window expired. The change was not applied. Ask them to send a fresh request.",
      tone: "error"
    };
  }
  if (status === "failed") {
    return {
      message: result?.error?.message
        ? `Failed: ${result.error.message}`
        : "The request failed after your decision.",
      tone: "error"
    };
  }
  if (decision === "allow-once") {
    if (status === "executing" || status === "approved") {
      return { message: "Approved once. Aroko is applying the reviewed change.", tone: "ok" };
    }
    return { message: "Approved once.", tone: "ok" };
  }
  if (decision === "allow-session") {
    return { message: "Allowed for this session.", tone: "ok" };
  }
  return { message: "Decision recorded.", tone: "info" };
}

/** Live poll: 1s when Live open or active work; else default. */
export function resolveLivePollIntervalMs(input) {
  if (input?.view === "live" || input?.tab === "live" || input?.tab === "activity") {
    return resolvePollIntervalMs({ tab: "live" });
  }
  const items = Array.isArray(input?.liveItems) ? input.liveItems : [];
  if (items.some((item) => item?.kind === "inspection" && item.status === "running")) {
    return resolvePollIntervalMs({ tab: "live" });
  }
  if (items.some((item) => item?.kind === "action" && isActionActivelyRunning(item))) {
    return resolvePollIntervalMs({ tab: "live", actions: items });
  }
  if (
    items.some(
      (item) =>
        item?.kind === "collaborative_task" &&
        item.terminal !== true &&
        String(item.waitingOn ?? "") === "provider"
    )
  ) {
    return resolvePollIntervalMs({ tab: "live" });
  }
  return resolvePollIntervalMs({
    tab: input?.view ?? input?.tab ?? "needs-you",
    actions: input?.actions,
    selectedAction: input?.selectedAction
  });
}

export function timelineContainsForbidden(progress) {
  const blob = JSON.stringify(progress ?? []);
  return [
    /chainOfThought/i,
    /agent_thought_chunk/i,
    /"thinking"/i,
    /"reasoning"/i,
    /absolutePath/i,
    /\/Users\/[^"\s]+/,
    /\/home\/[^"\s]+/
  ].some((re) => re.test(blob));
}

export function liveHtmlContainsForbiddenTech(html) {
  const text = String(html ?? "");
  return [
    /absolutePath/i,
    /chainOfThought/i,
    /agent_thought_chunk/i,
    /inviteSecret/i,
    /\bMCP\b/,
    /\bA2A\b/,
    /wss:\/\//i,
    /\/Users\/[^<\s]+/,
    /\/home\/[^<\s]+/
  ].some((re) => re.test(text));
}

export function findWorkItem(items, kind, id) {
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
