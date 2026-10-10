/**
 * R5-7 — Human-facing CollaborativeTask progress / history projections.
 *
 * Derived from authoritative SoT only (CollaborativeTask, InputRequest,
 * ProviderTurn, ContinuationEvent, ActionExecutionRecord). No second
 * orchestration state machine. No credentials / CoT / provider session refs.
 */
import {
  CONTINUATION_MAX_SUMMARY_CHARS,
  RECEIVER_AGENT_REQUEST_PROVENANCE,
  isTerminalCollaborativeTaskStatus,
  type ActionExecutionRecord,
  type CollaborativeTask,
  type CollaborativeTaskProgressPhase,
  type CollaborativeTaskWaitingOn,
  type ContinuationEvent,
  type InputRequest,
  type ProviderTurn
} from "@pairmesh/protocol";

const GOAL_DISPLAY_MAX = 240;
const TIMELINE_TEXT_MAX = 280;

export type CollaborativeTaskViewerRole = "requester" | "owner";

export interface SafeParticipantLabel {
  participantId: string;
  displayName: string;
}

export interface CollaborativeTaskProgressProjection {
  taskId: string;
  status: CollaborativeTask["status"];
  phase: CollaborativeTaskProgressPhase;
  phaseLabel: string;
  waitingOn: CollaborativeTaskWaitingOn;
  waitingOnLabel: string;
  originalGoal: string;
  goalSummary: string;
  requester: SafeParticipantLabel;
  owner: SafeParticipantLabel;
  collaboratorLabel: string;
  providerDisplayName?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  continuationSeq: number;
  pendingInputRequestId?: string;
  blockedOnActionId?: string;
  /** Requester-safe owner wait copy (never exact Action authority). */
  ownerWaitSummary?: string;
  /** Safe pending input for the requester (Answer semantics — not Approve). */
  pendingInput?: {
    inputRequestId: string;
    question: string;
    options?: string[];
    allowFreeText: boolean;
    interaction: "answer";
  };
  /** Owner-safe pending Action summary (Approve once remains on Action APIs). */
  pendingAction?: {
    actionId: string;
    actionType: string;
    label: string;
    provenanceLabel?: string;
  };
  resultSummary?: string;
  failureSummary?: string;
  terminal: boolean;
}

export interface CollaborativeTaskTimelineEvent {
  /** Durable identity for dedupe (one real event → one row). */
  eventKey: string;
  at: string;
  kind:
    | "task_created"
    | "provider_turn"
    | "input_request"
    | "input_answer"
    | "action_request"
    | "action_decision"
    | "action_terminal"
    | "continuation"
    | "task_resumed"
    | "task_terminal";
  label: string;
  detail?: string;
  sourceRef?: string;
}

export interface CollaborativeTaskHistoryProjection {
  taskId: string;
  goalSummary: string;
  originalGoal: string;
  requester: SafeParticipantLabel;
  owner: SafeParticipantLabel;
  providerDisplayName?: string;
  status: CollaborativeTask["status"];
  phase: CollaborativeTaskProgressPhase;
  phaseLabel: string;
  waitingOn: CollaborativeTaskWaitingOn;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  resultSummary?: string;
  failureSummary?: string;
  timeline: CollaborativeTaskTimelineEvent[];
}

export interface DeriveTaskProgressInput {
  task: CollaborativeTask;
  viewerRole: CollaborativeTaskViewerRole;
  requester: SafeParticipantLabel;
  owner: SafeParticipantLabel;
  inputRequests?: InputRequest[];
  actions?: ActionExecutionRecord[];
  providerTurns?: ProviderTurn[];
  continuationEvents?: ContinuationEvent[];
  /** Optional in-memory orchestrator hint (not required). */
  latestRecordedPhase?: CollaborativeTaskProgressPhase;
  providerDisplayName?: string;
}

function boundText(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function escapeIsNotNeededHere(value: string): string {
  // Projection returns plain text; Control Center must textContent-escape.
  return value;
}

export function summarizeGoal(originalGoal: string): string {
  return escapeIsNotNeededHere(boundText(originalGoal, GOAL_DISPLAY_MAX));
}

export function phaseLabel(phase: CollaborativeTaskProgressPhase): string {
  switch (phase) {
    case "working_on_request":
      return "Working on request";
    case "needs_requester_input":
      return "Waiting for requester";
    case "requester_answered":
      return "Requester answered";
    case "waiting_for_owner_action":
      return "Waiting for owner";
    case "owner_resolved_action":
      return "Owner resolved action";
    case "running_approved_work":
      return "Running approved work";
    case "continuing_work":
      return "Continuing work";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default: {
      const _exhaustive: never = phase;
      return String(_exhaustive);
    }
  }
}

export function waitingOnLabel(waitingOn: CollaborativeTaskWaitingOn): string {
  switch (waitingOn) {
    case "none":
      return "None";
    case "requester":
      return "Requester";
    case "owner":
      return "Owner";
    case "provider":
      return "Provider";
    default: {
      const _exhaustive: never = waitingOn;
      return String(_exhaustive);
    }
  }
}

function findAction(
  actions: ActionExecutionRecord[] | undefined,
  actionId: string | undefined
): ActionExecutionRecord | undefined {
  if (!actionId || !actions) {
    return undefined;
  }
  return actions.find((entry) => entry.actionId === actionId);
}

function findInput(
  inputs: InputRequest[] | undefined,
  inputRequestId: string | undefined
): InputRequest | undefined {
  if (!inputRequestId || !inputs) {
    return undefined;
  }
  return inputs.find((entry) => entry.inputRequestId === inputRequestId);
}

function latestContinuation(
  events: ContinuationEvent[] | undefined,
  taskId: string
): ContinuationEvent | undefined {
  if (!events?.length) {
    return undefined;
  }
  const matched = events.filter((entry) => entry.taskId === taskId);
  if (matched.length === 0) {
    return undefined;
  }
  return matched.reduce((best, entry) =>
    entry.continuationSeq >= best.continuationSeq ? entry : best
  );
}

function actionTypeLabel(actionType: string): string {
  switch (actionType) {
    case "change.propose":
      return "code change proposal";
    case "repository.edit":
      return "application of an approved change";
    case "tests.run":
      return "test run";
    case "process.execute":
      return "command";
    default:
      return actionType;
  }
}

/**
 * Provenance copy for Needs You / History.
 * receiver_agent_request MUST NOT be framed as the requester asking for the command.
 */
export function formatReceiverAgentActionProvenance(input: {
  originProvenance?: string;
  requesterDisplayName?: string;
}): string | undefined {
  if (input.originProvenance !== RECEIVER_AGENT_REQUEST_PROVENANCE) {
    return undefined;
  }
  const name = input.requesterDisplayName?.trim();
  if (name) {
    return `Requested by your agent while working on ${name}'s task.`;
  }
  return "Requested by your agent while working on a collaborative task.";
}

export function deriveCollaborativeTaskPhase(
  input: DeriveTaskProgressInput
): CollaborativeTaskProgressPhase {
  const { task, actions, continuationEvents, latestRecordedPhase } = input;
  if (task.status === "completed") {
    return "completed";
  }
  if (task.status === "failed" || task.status === "timed_out") {
    return "failed";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "waiting_for_input") {
    return "needs_requester_input";
  }
  if (task.status === "blocked_on_action") {
    const action = findAction(actions, task.blockedOnActionId);
    if (
      action &&
      (action.status === "approved" ||
        action.status === "executing" ||
        action.status === "authorizing")
    ) {
      return "running_approved_work";
    }
    if (action?.status === "approval_required") {
      return "waiting_for_owner_action";
    }
    // Linked Action missing or already terminal without observe — not approvable in Needs you.
    return "continuing_work";
  }

  const latest = latestContinuation(continuationEvents, task.taskId);
  if (latest?.type === "REQUESTER_INPUT_RECEIVED" && task.continuationSeq > 0) {
    if (latestRecordedPhase === "requester_answered") {
      return "requester_answered";
    }
    return task.activeProviderTurnId ? "continuing_work" : "requester_answered";
  }
  if (latest && latest.type.startsWith("ACTION_") && task.continuationSeq > 0) {
    if (latestRecordedPhase === "owner_resolved_action") {
      return "owner_resolved_action";
    }
    return task.activeProviderTurnId || task.status === "working"
      ? "continuing_work"
      : "owner_resolved_action";
  }
  if (task.continuationSeq > 0) {
    return "continuing_work";
  }
  if (latestRecordedPhase === "working_on_request" || task.activeProviderTurnId) {
    return "working_on_request";
  }
  return "working_on_request";
}

export function deriveCollaborativeTaskWaitingOn(
  input: DeriveTaskProgressInput
): CollaborativeTaskWaitingOn {
  const { task, actions } = input;
  if (isTerminalCollaborativeTaskStatus(task.status)) {
    return "none";
  }
  if (task.status === "waiting_for_input") {
    return "requester";
  }
  if (task.status === "blocked_on_action") {
    const action = findAction(actions, task.blockedOnActionId);
    if (action?.status === "approval_required") {
      return "owner";
    }
    if (
      action &&
      (action.status === "approved" ||
        action.status === "executing" ||
        action.status === "authorizing")
    ) {
      return "provider";
    }
    // Completed/expired/denied/missing — Needs you is empty; do not claim waiting on owner.
    return "provider";
  }
  if (task.activeProviderTurnId || task.status === "working") {
    return "provider";
  }
  return "provider";
}

export function projectCollaborativeTaskProgress(
  input: DeriveTaskProgressInput
): CollaborativeTaskProgressProjection {
  const phase = deriveCollaborativeTaskPhase(input);
  const waitingOn = deriveCollaborativeTaskWaitingOn(input);
  const { task, viewerRole, requester, owner } = input;
  const collaborator = viewerRole === "requester" ? owner : requester;
  const pendingInput = findInput(input.inputRequests, task.pendingInputRequestId);
  const blockedAction = findAction(input.actions, task.blockedOnActionId);

  const projection: CollaborativeTaskProgressProjection = {
    taskId: task.taskId,
    status: task.status,
    phase,
    phaseLabel: phaseLabel(phase),
    waitingOn,
    waitingOnLabel: waitingOnLabel(waitingOn),
    originalGoal: task.originalGoal,
    goalSummary: summarizeGoal(task.originalGoal),
    requester,
    owner,
    collaboratorLabel: collaborator.displayName,
    ...(input.providerDisplayName ? { providerDisplayName: input.providerDisplayName } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    continuationSeq: task.continuationSeq,
    ...(task.pendingInputRequestId ? { pendingInputRequestId: task.pendingInputRequestId } : {}),
    ...(task.blockedOnActionId ? { blockedOnActionId: task.blockedOnActionId } : {}),
    terminal: isTerminalCollaborativeTaskStatus(task.status)
  };

  if (viewerRole === "requester" && waitingOn === "owner") {
    projection.ownerWaitSummary = `Waiting for ${owner.displayName} to approve an action.`;
  }

  if (
    viewerRole === "requester" &&
    pendingInput &&
    pendingInput.status === "pending" &&
    pendingInput.question
  ) {
    projection.pendingInput = {
      inputRequestId: pendingInput.inputRequestId,
      question: boundText(pendingInput.question, CONTINUATION_MAX_SUMMARY_CHARS),
      ...(pendingInput.options?.length ? { options: pendingInput.options } : {}),
      allowFreeText: pendingInput.allowFreeText !== false,
      interaction: "answer"
    };
  }

  if (viewerRole === "owner" && blockedAction?.status === "approval_required") {
    const provenanceLabel = formatReceiverAgentActionProvenance({
      originProvenance: blockedAction.originProvenance,
      requesterDisplayName: requester.displayName
    });
    projection.pendingAction = {
      actionId: blockedAction.actionId,
      actionType: blockedAction.actionType,
      label: `Approve ${actionTypeLabel(blockedAction.actionType)}`,
      ...(provenanceLabel ? { provenanceLabel } : {})
    };
  }

  if (task.result?.summary) {
    projection.resultSummary = boundText(task.result.summary, CONTINUATION_MAX_SUMMARY_CHARS);
  }
  if (task.failure) {
    projection.failureSummary = boundText(
      task.failure.message || task.failure.code,
      CONTINUATION_MAX_SUMMARY_CHARS
    );
  }

  return projection;
}

function pushUnique(
  rows: CollaborativeTaskTimelineEvent[],
  seen: Set<string>,
  row: CollaborativeTaskTimelineEvent
): void {
  if (seen.has(row.eventKey)) {
    return;
  }
  seen.add(row.eventKey);
  rows.push(row);
}

function actionDecisionLabel(status: string, ownerName: string): string | undefined {
  if (status === "approved" || status === "executing" || status === "completed") {
    // Prefer explicit approval language only when we know approval happened;
    // for completed we still say approved once if it was approval_required flow.
    return `${ownerName} approved once.`;
  }
  if (status === "denied") {
    return `${ownerName} denied the action.`;
  }
  return undefined;
}

function actionTerminalLabel(action: ActionExecutionRecord): string {
  switch (action.status) {
    case "completed":
      if (action.actionType === "process.execute") {
        return "Command completed.";
      }
      return "Action completed.";
    case "denied":
      return "Action was denied.";
    case "failed":
      return "Action failed.";
    case "unknown_outcome":
      return "Execution outcome is uncertain.";
    case "cancelled":
      return "Action was cancelled.";
    case "expired":
      return "Action expired.";
    default:
      return `Action ${action.status}.`;
  }
}

function actionRequestLabel(action: ActionExecutionRecord): string {
  switch (action.actionType) {
    case "change.propose":
      return "Agent requested a code change proposal.";
    case "repository.edit":
      return "Agent requested application of an approved change.";
    case "tests.run": {
      const profile =
        typeof action.parameters === "object" &&
        action.parameters &&
        "profileName" in action.parameters &&
        typeof (action.parameters as { profileName?: unknown }).profileName === "string"
          ? String((action.parameters as { profileName: string }).profileName)
          : undefined;
      return profile
        ? `Agent requested test profile: ${boundText(profile, 80)}.`
        : "Agent requested a test run.";
    }
    case "process.execute": {
      const display =
        typeof action.result?.outputs?.commandDisplay === "string"
          ? action.result.outputs.commandDisplay
          : undefined;
      const fromParams =
        action.parameters &&
        typeof action.parameters === "object" &&
        "executable" in action.parameters
          ? `${String((action.parameters as { executable: string }).executable)}${
              Array.isArray((action.parameters as { args?: string[] }).args)
                ? ` ${(action.parameters as { args: string[] }).args.join(" ")}`
                : ""
            }`
          : undefined;
      const cmd = boundText(display ?? fromParams ?? "command", 120);
      return `Agent requested command: ${cmd}.`;
    }
    default:
      return `Agent requested ${action.actionType}.`;
  }
}

export function buildCollaborativeTaskTimeline(
  input: DeriveTaskProgressInput
): CollaborativeTaskTimelineEvent[] {
  const { task, requester, owner, providerTurns, inputRequests, actions, continuationEvents } =
    input;
  const rows: CollaborativeTaskTimelineEvent[] = [];
  const seen = new Set<string>();
  const providerName = input.providerDisplayName ?? "Agent";

  pushUnique(rows, seen, {
    eventKey: `task_created:${task.taskId}`,
    at: task.createdAt,
    kind: "task_created",
    label: `${requester.displayName} asked ${owner.displayName} to help.`,
    detail: boundText(task.originalGoal, TIMELINE_TEXT_MAX)
  });

  for (const turn of providerTurns ?? []) {
    if (turn.taskId !== task.taskId) {
      continue;
    }
    // ProviderTurn has no continuationSeq — first turn lacks continuationEventId.
    const startedLabel = !turn.continuationEventId
      ? `${providerName} started working.`
      : `${providerName} continued working.`;
    pushUnique(rows, seen, {
      eventKey: `provider_turn_start:${turn.providerTurnId}`,
      at: turn.startedAt,
      kind: "provider_turn",
      label: startedLabel,
      sourceRef: turn.providerTurnId
    });
    if (turn.endedAt) {
      let endLabel = `${providerName} finished.`;
      if (turn.status === "failed") {
        endLabel = `${providerName} could not continue.`;
      } else if (turn.status === "cancelled") {
        endLabel = `${providerName} was cancelled.`;
      }
      pushUnique(rows, seen, {
        eventKey: `provider_turn_end:${turn.providerTurnId}`,
        at: turn.endedAt,
        kind: "provider_turn",
        label: endLabel,
        ...(turn.checkpointSummary
          ? { detail: boundText(turn.checkpointSummary, TIMELINE_TEXT_MAX) }
          : {}),
        sourceRef: turn.providerTurnId
      });
    }
  }

  for (const inputReq of inputRequests ?? []) {
    if (inputReq.taskId !== task.taskId) {
      continue;
    }
    pushUnique(rows, seen, {
      eventKey: `input_request:${inputReq.inputRequestId}`,
      at: inputReq.createdAt,
      kind: "input_request",
      label: `${providerName} asked ${requester.displayName} for clarification.`,
      detail: boundText(inputReq.question, TIMELINE_TEXT_MAX),
      sourceRef: inputReq.inputRequestId
    });
    if (inputReq.status === "answered" && inputReq.answeredAt) {
      pushUnique(rows, seen, {
        eventKey: `input_answer:${inputReq.inputRequestId}`,
        at: inputReq.answeredAt,
        kind: "input_answer",
        label: `${requester.displayName} answered.`,
        ...(typeof inputReq.answer === "string"
          ? { detail: boundText(inputReq.answer, TIMELINE_TEXT_MAX) }
          : {}),
        sourceRef: inputReq.inputRequestId
      });
    } else if (inputReq.status === "expired") {
      pushUnique(rows, seen, {
        eventKey: `input_expired:${inputReq.inputRequestId}`,
        at: inputReq.expiresAt ?? inputReq.createdAt,
        kind: "input_request",
        label: "Request for input expired.",
        sourceRef: inputReq.inputRequestId
      });
    } else if (inputReq.status === "cancelled") {
      pushUnique(rows, seen, {
        eventKey: `input_cancelled:${inputReq.inputRequestId}`,
        at: inputReq.createdAt,
        kind: "input_request",
        label: "Request for input was cancelled.",
        sourceRef: inputReq.inputRequestId
      });
    }
  }

  for (const action of actions ?? []) {
    if (action.taskId !== task.taskId) {
      continue;
    }
    pushUnique(rows, seen, {
      eventKey: `action_request:${action.actionId}`,
      at: action.createdAt,
      kind: "action_request",
      label: actionRequestLabel(action),
      ...(formatReceiverAgentActionProvenance({
        originProvenance: action.originProvenance,
        requesterDisplayName: requester.displayName
      })
        ? {
            detail: formatReceiverAgentActionProvenance({
              originProvenance: action.originProvenance,
              requesterDisplayName: requester.displayName
            })
          }
        : {}),
      sourceRef: action.actionId
    });

    const decisionAt = action.updatedAt;
    if (action.status === "denied") {
      pushUnique(rows, seen, {
        eventKey: `action_decision:${action.actionId}`,
        at: decisionAt,
        kind: "action_decision",
        label: `${owner.displayName} denied the requested action.`,
        sourceRef: action.actionId
      });
    } else if (
      action.status === "approved" ||
      action.status === "executing" ||
      action.status === "completed" ||
      action.status === "failed" ||
      action.status === "unknown_outcome"
    ) {
      // Emit approval once when we leave approval_required.
      pushUnique(rows, seen, {
        eventKey: `action_decision:${action.actionId}`,
        at: decisionAt,
        kind: "action_decision",
        label:
          actionDecisionLabel(action.status, owner.displayName) ??
          `${owner.displayName} approved once.`,
        sourceRef: action.actionId
      });
    }

    if (
      action.status === "completed" ||
      action.status === "failed" ||
      action.status === "unknown_outcome" ||
      action.status === "cancelled" ||
      action.status === "expired" ||
      action.status === "denied"
    ) {
      pushUnique(rows, seen, {
        eventKey: `action_terminal:${action.actionId}:${action.status}`,
        at: action.completedAt ?? action.updatedAt,
        kind: "action_terminal",
        label: actionTerminalLabel(action),
        sourceRef: action.actionId
      });
    }
  }

  for (const event of continuationEvents ?? []) {
    if (event.taskId !== task.taskId) {
      continue;
    }
    if (event.type === "TASK_RESUMED_AFTER_RESTART") {
      pushUnique(rows, seen, {
        eventKey: `continuation:${event.eventId}`,
        at: event.occurredAt,
        kind: "task_resumed",
        label: "Work resumed after reconnect/restart.",
        sourceRef: event.eventId
      });
      continue;
    }
    // Significant continuation markers already covered by input/action rows;
    // keep a single safe summary when useful.
    if (event.type === "REQUESTER_INPUT_RECEIVED" || event.type.startsWith("ACTION_")) {
      pushUnique(rows, seen, {
        eventKey: `continuation:${event.eventId}`,
        at: event.occurredAt,
        kind: "continuation",
        label: boundText(event.safeSummary || event.type, TIMELINE_TEXT_MAX),
        sourceRef: event.eventId
      });
    }
  }

  if (task.completedAt) {
    let terminalLabel = "Task completed.";
    if (task.status === "failed" || task.status === "timed_out") {
      terminalLabel = task.failure?.message
        ? boundText(task.failure.message, TIMELINE_TEXT_MAX)
        : "Task failed.";
    } else if (task.status === "cancelled") {
      terminalLabel = "Task cancelled.";
    }
    pushUnique(rows, seen, {
      eventKey: `task_terminal:${task.taskId}`,
      at: task.completedAt,
      kind: "task_terminal",
      label: terminalLabel,
      ...(task.result?.summary ? { detail: boundText(task.result.summary, TIMELINE_TEXT_MAX) } : {})
    });
  }

  return rows.sort((a, b) => {
    const at = a.at.localeCompare(b.at);
    if (at !== 0) {
      return at;
    }
    return a.eventKey.localeCompare(b.eventKey);
  });
}

export function projectCollaborativeTaskHistory(
  input: DeriveTaskProgressInput
): CollaborativeTaskHistoryProjection {
  const progress = projectCollaborativeTaskProgress(input);
  const startedMs = Date.parse(input.task.createdAt);
  const completedMs = input.task.completedAt ? Date.parse(input.task.completedAt) : undefined;
  return {
    taskId: progress.taskId,
    goalSummary: progress.goalSummary,
    originalGoal: progress.originalGoal,
    requester: progress.requester,
    owner: progress.owner,
    ...(progress.providerDisplayName ? { providerDisplayName: progress.providerDisplayName } : {}),
    status: progress.status,
    phase: progress.phase,
    phaseLabel: progress.phaseLabel,
    waitingOn: progress.waitingOn,
    startedAt: progress.createdAt,
    ...(progress.completedAt ? { completedAt: progress.completedAt } : {}),
    ...(Number.isFinite(startedMs) && completedMs !== undefined && Number.isFinite(completedMs)
      ? { durationMs: Math.max(0, completedMs - startedMs) }
      : {}),
    ...(progress.resultSummary ? { resultSummary: progress.resultSummary } : {}),
    ...(progress.failureSummary ? { failureSummary: progress.failureSummary } : {}),
    timeline: buildCollaborativeTaskTimeline(input)
  };
}

/** Compact Live card fields (Control Center). */
export function buildCollaborativeTaskLiveCard(progress: CollaborativeTaskProgressProjection): {
  kind: "collaborative_task";
  id: string;
  workKey: string;
  title: string;
  subtitle: string;
  phaseLabel: string;
  waitingOn: CollaborativeTaskWaitingOn;
  providerDisplayName?: string;
  updatedAt: string;
  status: string;
  terminal: boolean;
} {
  const who = `${progress.requester.displayName} → ${progress.owner.displayName}`;
  const waitingBit =
    progress.waitingOn === "requester"
      ? "Needs input"
      : progress.waitingOn === "owner"
        ? "Command approval"
        : progress.phaseLabel;
  return {
    kind: "collaborative_task",
    id: progress.taskId,
    workKey: `collaborative_task:${progress.taskId}`,
    title: who,
    subtitle: progress.goalSummary,
    phaseLabel: `${progress.phaseLabel}${progress.providerDisplayName ? ` · ${progress.providerDisplayName}` : ""}`,
    waitingOn: progress.waitingOn,
    ...(progress.providerDisplayName ? { providerDisplayName: progress.providerDisplayName } : {}),
    updatedAt: progress.updatedAt,
    status: progress.status,
    terminal: progress.terminal,
    // keep waitingBit available via phaseLabel composition for Needs-input cards
    ...(waitingBit && progress.waitingOn !== "none" && progress.waitingOn !== "provider" ? {} : {})
  };
}
