import {
  projectCollaborativeTaskProgress,
  summarizeGoal,
  type CollaborativeTaskProgressProjection,
  type LocalSessionState,
  type SafeParticipantLabel
} from "@pairmesh/client";
import type { CollaborativeTask } from "@pairmesh/protocol";
import { flagValue } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

export async function runTaskCommand(
  flags: Record<string, string>,
  positionals: string[] = [],
  subcommand?: string
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const action = subcommand ?? positionals[0];
  const args = subcommand ? positionals : positionals.slice(1);

  if (!action || action === "pending") {
    const pending = await manager.listPendingInputRequests();
    const state = await manager.readActiveSessionState();
    const rows = pending.map((row) => {
      const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === row.taskId);
      return {
        ...row,
        interaction: "answer" as const,
        ...(task ? { goalSummary: summarizeGoal(task.originalGoal) } : {})
      };
    });
    if (flags.json === "true") {
      console.log(JSON.stringify({ pending: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No pending InputRequests.");
      return;
    }
    console.log("Kelvin's agent needs your input:\n");
    for (const row of rows) {
      console.log(`${row.inputRequestId}`);
      console.log(`  task=${row.taskId}`);
      console.log(`  interaction=answer`);
      if (row.goalSummary) {
        console.log(`  goal=${row.goalSummary}`);
      }
      console.log(`  question=${row.question}`);
      if (row.options?.length) {
        console.log(`  options=${row.options.join(" | ")}`);
      }
      console.log("");
    }
    return;
  }

  if (action === "show") {
    const id = args[0];
    if (!id) {
      throw new Error(`Usage: ${cliBinaryLabel()} task show <taskId|inputRequestId>`);
    }
    if (id.startsWith("inq_")) {
      const input = await manager.getInputRequest(id);
      if (!input) {
        throw new Error(`InputRequest ${id} not found.`);
      }
      const bounded = {
        inputRequestId: input.inputRequestId,
        taskId: input.taskId,
        status: input.status,
        question: input.question,
        ...(input.options?.length ? { options: input.options } : {}),
        allowFreeText: input.allowFreeText,
        interaction: "answer" as const,
        ...(input.answer ? { answer: input.answer } : {}),
        createdAt: input.createdAt,
        ...(input.answeredAt ? { answeredAt: input.answeredAt } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
      };
      if (flags.json === "true") {
        console.log(JSON.stringify(bounded, null, 2));
        return;
      }
      console.log(`${input.inputRequestId}  status=${input.status}`);
      console.log(`task=${input.taskId}`);
      console.log(`interaction=answer`);
      console.log(`question=${input.question}`);
      if (input.options?.length) {
        console.log(`options=${input.options.join(" | ")}`);
      }
      if (input.answer) {
        console.log(`answer=${input.answer}`);
      }
      return;
    }
    const progress = await loadTaskProgress(manager, id);
    if (!progress) {
      throw new Error(`CollaborativeTask ${id} not found.`);
    }
    if (flags.json === "true") {
      console.log(JSON.stringify(boundProgressJson(progress), null, 2));
      return;
    }
    printTaskProgressHuman(progress);
    return;
  }

  if (action === "run") {
    const goal = flagValue(flags, "goal") ?? args.join(" ");
    if (!goal) {
      throw new Error(
        `Usage: ${cliBinaryLabel()} task run --goal "..." | ${cliBinaryLabel()} task run "<goal text>"`
      );
    }
    const provider = flagValue(flags, "provider") as
      "fake" | "claude-code" | "cursor" | "gemini-cli" | undefined;
    const result = await manager.runCollaborativeGoal({
      originalGoal: goal,
      ...(provider ? { providerId: provider } : {})
    });
    if (flags.json === "true") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Goal started ${result.taskId} status=${result.status}`);
    console.log(result.presentation);
    return;
  }

  if (action === "continue") {
    const taskId = args[0];
    if (!taskId) {
      throw new Error(`Usage: ${cliBinaryLabel()} task continue <taskId>`);
    }
    const result = await manager.continueCollaborativeGoal(taskId);
    if (flags.json === "true") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Continued ${result.taskId} status=${result.taskStatus} turn=${result.turnResult.kind}`
    );
    return;
  }

  if (action === "create") {
    const goal = flagValue(flags, "goal") ?? args.join(" ");
    if (!goal) {
      throw new Error(`Usage: ${cliBinaryLabel()} task create --goal "..."`);
    }
    const requester = flagValue(flags, "requester");
    const task = await manager.createCollaborativeTask({
      originalGoal: goal,
      ...(requester ? { requesterParticipantId: requester } : {})
    });
    if (flags.json === "true") {
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    console.log(`Created ${task.taskId} status=${task.status}`);
    return;
  }

  if (action === "ask" || action === "request-input") {
    const taskId = args[0];
    const question = flagValue(flags, "question") ?? args.slice(1).join(" ");
    if (!taskId || !question) {
      throw new Error(
        `Usage: ${cliBinaryLabel()} task ask <taskId> --question "..." [--option Yes] [--option No]`
      );
    }
    const options = collectOptions(flags, positionals, subcommand);
    const result = await manager.createAndDeliverInputRequest({
      taskId,
      question,
      ...(options.length > 0 ? { options } : {})
    });
    if (flags.json === "true") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `InputRequest ${result.inputRequest.inputRequestId} pending on ${result.task.taskId} (delivered=${result.delivered})`
    );
    console.log(`question=${result.inputRequest.question}`);
    return;
  }

  if (action === "answer") {
    const id = args[0];
    const answer =
      flagValue(flags, "text") ?? flagValue(flags, "answer") ?? args.slice(1).join(" ");
    if (!id || !answer) {
      throw new Error(
        `Usage: ${cliBinaryLabel()} task answer <inputRequestId> --text "Yes" [--task task_...]`
      );
    }
    const taskId = flagValue(flags, "task");
    const result = await manager.answerCollaborativeInputRequest({
      inputRequestId: id,
      answer,
      ...(taskId ? { taskId } : {})
    });
    if (flags.json === "true") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const taskStatus =
      result && typeof result === "object" && "task" in result && result.task
        ? (result.task as { status?: string; continuationSeq?: number }).status
        : undefined;
    const seq =
      result && typeof result === "object" && "task" in result && result.task
        ? (result.task as { continuationSeq?: number }).continuationSeq
        : undefined;
    console.log(
      `Answer accepted. task status=${taskStatus ?? "unknown"} continuationSeq=${seq ?? "?"}`
    );
    return;
  }

  const bin = cliBinaryLabel();
  throw new Error(
    `Usage: ${bin} task pending|show|create|run|continue|ask|answer\n` +
      `  ${bin} task pending\n` +
      `  ${bin} task show <taskId|inputRequestId>\n` +
      `  ${bin} task create --goal "..."\n` +
      `  ${bin} task run --goal "..." [--provider fake|claude-code|cursor|gemini-cli]\n` +
      `  ${bin} task continue <taskId>\n` +
      `  ${bin} task ask <taskId> --question "..." [--option Yes]\n` +
      `  ${bin} task answer <inputRequestId> --text "Yes"`
  );
}

type SessionManagerLike = Awaited<ReturnType<typeof createSessionManagerFromResolvedConfig>>;

async function loadTaskProgress(
  manager: SessionManagerLike,
  taskId: string
): Promise<CollaborativeTaskProgressProjection | null> {
  const task = await manager.getCollaborativeTask(taskId);
  if (!task) {
    return null;
  }
  const state = await manager.readActiveSessionState();
  return projectFromState(state, task);
}

function projectFromState(
  state: LocalSessionState,
  task: CollaborativeTask
): CollaborativeTaskProgressProjection {
  const localId = state.localParticipant.participant.id;
  const viewerRole = localId === task.ownerParticipantId ? "owner" : "requester";
  return projectCollaborativeTaskProgress({
    task,
    viewerRole,
    requester: resolveParticipantLabel(state, task.requesterParticipantId),
    owner: resolveParticipantLabel(state, task.ownerParticipantId),
    inputRequests: (state.inputRequests ?? []).filter((entry) => entry.taskId === task.taskId),
    actions: (state.actionExecutions ?? []).filter((entry) => entry.taskId === task.taskId),
    providerTurns: (state.providerTurns ?? []).filter((entry) => entry.taskId === task.taskId),
    continuationEvents: (state.continuationEvents ?? []).filter(
      (entry) => entry.taskId === task.taskId
    )
  });
}

function resolveParticipantLabel(
  state: LocalSessionState,
  participantId: string
): SafeParticipantLabel {
  if (state.localParticipant.participant.id === participantId) {
    return {
      participantId,
      displayName: state.localParticipant.developer.displayName
    };
  }
  const peer = state.peers.find((entry) => entry.participant.id === participantId);
  return {
    participantId,
    displayName: peer?.developer.displayName ?? participantId
  };
}

/** Machine-safe subset — no appliedEvents / tokens / provider session refs. */
function boundProgressJson(progress: CollaborativeTaskProgressProjection) {
  return {
    taskId: progress.taskId,
    status: progress.status,
    phase: progress.phase,
    phaseLabel: progress.phaseLabel,
    waitingOn: progress.waitingOn,
    waitingOnLabel: progress.waitingOnLabel,
    goalSummary: progress.goalSummary,
    requester: progress.requester,
    owner: progress.owner,
    collaboratorLabel: progress.collaboratorLabel,
    ...(progress.providerDisplayName ? { providerDisplayName: progress.providerDisplayName } : {}),
    continuationSeq: progress.continuationSeq,
    ...(progress.pendingInputRequestId
      ? { pendingInputRequestId: progress.pendingInputRequestId }
      : {}),
    ...(progress.blockedOnActionId ? { blockedOnActionId: progress.blockedOnActionId } : {}),
    ...(progress.ownerWaitSummary ? { ownerWaitSummary: progress.ownerWaitSummary } : {}),
    ...(progress.pendingInput ? { pendingInput: progress.pendingInput } : {}),
    ...(progress.pendingAction ? { pendingAction: progress.pendingAction } : {}),
    ...(progress.resultSummary ? { resultSummary: progress.resultSummary } : {}),
    ...(progress.failureSummary ? { failureSummary: progress.failureSummary } : {}),
    terminal: progress.terminal,
    createdAt: progress.createdAt,
    updatedAt: progress.updatedAt,
    ...(progress.completedAt ? { completedAt: progress.completedAt } : {})
  };
}

function printTaskProgressHuman(progress: CollaborativeTaskProgressProjection): void {
  console.log(
    `${progress.taskId}  status=${progress.status}  continuationSeq=${progress.continuationSeq}`
  );
  console.log(`phase=${progress.phase}  (${progress.phaseLabel})`);
  console.log(`waitingOn=${progress.waitingOn}  (${progress.waitingOnLabel})`);
  console.log(`goal=${progress.goalSummary}`);
  if (progress.ownerWaitSummary) {
    console.log(`ownerWait=${progress.ownerWaitSummary}`);
  }
  if (progress.pendingInput) {
    console.log(`pendingInput=${progress.pendingInput.inputRequestId}`);
    console.log(`  interaction=${progress.pendingInput.interaction}`);
    console.log(`  question=${progress.pendingInput.question}`);
    if (progress.pendingInput.options?.length) {
      console.log(`  options=${progress.pendingInput.options.join(" | ")}`);
    }
  } else if (progress.pendingInputRequestId) {
    console.log(`pendingInput=${progress.pendingInputRequestId}`);
  }
  if (progress.pendingAction) {
    console.log(`pendingAction=${progress.pendingAction.actionId}`);
    console.log(`  label=${progress.pendingAction.label}`);
    if (progress.pendingAction.provenanceLabel) {
      console.log(`  provenance=${progress.pendingAction.provenanceLabel}`);
    }
  } else if (progress.blockedOnActionId) {
    console.log(`blockedOnAction=${progress.blockedOnActionId}`);
  }
  if (progress.resultSummary) {
    console.log(`result=${progress.resultSummary}`);
  }
  if (progress.failureSummary) {
    console.log(`failure=${progress.failureSummary}`);
  }
}

function collectOptions(
  flags: Record<string, string>,
  positionals: string[],
  subcommand?: string
): string[] {
  const options: string[] = [];
  const single = flagValue(flags, "option");
  if (single) {
    options.push(single);
  }
  // Support repeated --option via raw argv scan is limited; allow comma list.
  const list = flagValue(flags, "options");
  if (list) {
    options.push(
      ...list
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    );
  }
  void positionals;
  void subcommand;
  return options;
}
