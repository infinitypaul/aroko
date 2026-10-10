import { createHash, randomUUID } from "node:crypto";
import {
  ArtifactIdSchema,
  COLLABORATIVE_TASK_MAX_CHILD_ACTIONS,
  CollaborativeTaskIdSchema,
  CollaborativeTaskSchema,
  HostRequestTrustedContextSchema,
  HostToolCallIdSchema,
  HostToolCallRecordSchema,
  PAIRMESH_HOST_REQUEST_TOOLS,
  PeerIdSchema,
  ProviderTurnIdSchema,
  RECEIVER_AGENT_REQUEST_PROVENANCE,
  RequestChangeProposalArgsSchema,
  RequestProcessExecutionArgsSchema,
  RequestRepositoryEditArgsSchema,
  RequestRequesterInputArgsSchema,
  RequestTestsRunArgsSchema,
  SessionIdSchema,
  createPairMeshError,
  isTerminalCollaborativeTaskStatus,
  type HostRequestTrustedContext,
  type HostToolCallRecord,
  type HostToolSuccessResult,
  type PairMeshHostRequestToolName
} from "@pairmesh/protocol";
import { ensureDefaultGrants, getGrantPolicy } from "../auth/capabilities.js";
import { requireActionTypeDefinition } from "../action/registry.js";
import type { ActionService } from "../action/service.js";
import type { LocalSessionState } from "../session/schemas.js";
import type { LocalStateStore } from "../state/store.js";
import { InputRequestService } from "./input-request-service.js";
import { mintCollaborativeTaskEventId } from "./collaborative-task-service.js";

export interface HostRequestBridgeOptions {
  stateStore: LocalStateStore;
  actionService: ActionService;
  /**
   * Optional deliver hook after InputRequest create (R5-3 A2A).
   * Must not create Actions. Failures should not roll back create if already durable.
   */
  deliverInputRequest?: (input: { taskId: string; inputRequestId: string }) => Promise<void>;
}

function argsDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rememberHostCall(state: LocalSessionState, record: HostToolCallRecord): void {
  if (!state.hostToolCalls) {
    state.hostToolCalls = [];
  }
  state.hostToolCalls.push(record);
  while (state.hostToolCalls.length > 200) {
    state.hostToolCalls.shift();
  }
}

function findHostCall(
  state: LocalSessionState,
  hostToolCallId: string
): HostToolCallRecord | undefined {
  return (state.hostToolCalls ?? []).find((entry) => entry.hostToolCallId === hostToolCallId);
}

function countTaskActions(state: LocalSessionState, taskId: string): number {
  const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === taskId);
  if (!task) {
    return 0;
  }
  return task.childRefs.filter((ref) => ref.kind === "action").length;
}

function assertTaskAcceptsHostRequest(state: LocalSessionState, taskId: string): void {
  const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === taskId);
  if (!task) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_not_found",
      message: `CollaborativeTask ${taskId} not found.`,
      details: { taskId }
    });
  }
  if (isTerminalCollaborativeTaskStatus(task.status)) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_invalid_transition",
      message: `Terminal task cannot accept host requests (status=${task.status}).`,
      details: { taskId, status: task.status }
    });
  }
  if (task.status === "waiting_for_input") {
    throw createPairMeshError({
      code: "pairmesh.host_tool_not_allowed",
      message: "Task is waiting_for_input; cannot create another host child yet.",
      details: { taskId, status: task.status }
    });
  }
  if (task.status === "blocked_on_action") {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_already_blocked",
      message: "Task already has a blocking Action; only one blockedOnActionId is allowed.",
      details: { taskId, blockedOnActionId: task.blockedOnActionId ?? null }
    });
  }
  if (task.status !== "working") {
    throw createPairMeshError({
      code: "pairmesh.host_tool_not_allowed",
      message: `Task must be working to accept host requests (got ${task.status}).`,
      details: { taskId, status: task.status }
    });
  }
}

function replaySuccess(
  prior: HostToolCallRecord,
  toolName: PairMeshHostRequestToolName
): HostToolSuccessResult {
  if (prior.outcome === "input_request" && prior.inputRequestId) {
    return {
      status: "waiting_for_requester",
      inputRequestId: prior.inputRequestId,
      taskId: prior.taskId,
      hostToolCallId: prior.hostToolCallId
    };
  }
  if (prior.outcome === "action" && prior.actionId) {
    return {
      status: "waiting_for_owner",
      actionId: prior.actionId,
      taskId: prior.taskId,
      hostToolCallId: prior.hostToolCallId
    };
  }
  throw createPairMeshError({
    code: "pairmesh.host_tool_conflict",
    message: `Stored host tool call ${prior.hostToolCallId} is incomplete for ${toolName}.`,
    details: { hostToolCallId: prior.hostToolCallId, toolName }
  });
}

/**
 * Receiver-worker host-mediated request bridge (R5-4).
 * Creates InputRequests / Actions only — never approves or executes.
 * Does not construct a LocalStateStore.
 */
export class HostRequestBridge {
  private readonly stateStore: LocalStateStore;
  private readonly actionService: ActionService;
  private readonly inputs: InputRequestService;
  private readonly deliverInputRequest?: HostRequestBridgeOptions["deliverInputRequest"];

  public constructor(options: HostRequestBridgeOptions) {
    this.stateStore = options.stateStore;
    this.actionService = options.actionService;
    this.inputs = new InputRequestService(options.stateStore);
    this.deliverInputRequest = options.deliverInputRequest;
  }

  public listTools(): readonly PairMeshHostRequestToolName[] {
    return PAIRMESH_HOST_REQUEST_TOOLS;
  }

  public async requestRequesterInput(
    trusted: HostRequestTrustedContext,
    rawArgs: unknown
  ): Promise<HostToolSuccessResult> {
    const context = this.parseTrusted(trusted);
    const args = RequestRequesterInputArgsSchema.parse(rawArgs);
    const digest = argsDigest(args);
    const prior = await this.lookupIdempotent(context, "request_requester_input", digest);
    if (prior) {
      return replaySuccess(prior, "request_requester_input");
    }

    await this.stateStore.enqueue(async () => {
      const state = await this.stateStore.load();
      if (!state) {
        throw createPairMeshError({
          code: "pairmesh.session_not_found",
          message: "No local PairMesh session found."
        });
      }
      assertTaskAcceptsHostRequest(state, context.taskId);
      this.assertTrustedMatchesTask(state, context);
    });

    const created = await this.inputs.createInputRequest({
      taskId: context.taskId,
      question: args.question,
      options: args.options,
      allowFreeText: args.allowFreeText
    });

    await this.stateStore.mutate((state) => {
      rememberHostCall(
        state,
        HostToolCallRecordSchema.parse({
          hostToolCallId: context.hostToolCallId,
          taskId: context.taskId,
          toolName: "request_requester_input",
          argsDigest: digest,
          outcome: "input_request",
          inputRequestId: created.inputRequest.inputRequestId,
          createdAt: created.inputRequest.createdAt
        })
      );
    });

    if (this.deliverInputRequest) {
      try {
        await this.deliverInputRequest({
          taskId: created.task.taskId,
          inputRequestId: created.inputRequest.inputRequestId
        });
      } catch {
        // Delivery is best-effort after durable create; R5-3 reconnect recovers.
      }
    }

    return {
      status: "waiting_for_requester",
      inputRequestId: created.inputRequest.inputRequestId,
      taskId: created.task.taskId,
      hostToolCallId: context.hostToolCallId
    };
  }

  public async requestChangeProposal(
    trusted: HostRequestTrustedContext,
    rawArgs: unknown
  ): Promise<HostToolSuccessResult> {
    const args = RequestChangeProposalArgsSchema.parse(rawArgs);
    return this.createBlockingAction(trusted, "request_change_proposal", args, {
      actionType: "change.propose",
      parameters: { instruction: args.instruction }
    });
  }

  public async requestRepositoryEdit(
    trusted: HostRequestTrustedContext,
    rawArgs: unknown
  ): Promise<HostToolSuccessResult> {
    const args = RequestRepositoryEditArgsSchema.parse(rawArgs);
    return this.createBlockingAction(trusted, "request_repository_edit", args, {
      actionType: "repository.edit",
      artifactRef: {
        artifactId: ArtifactIdSchema.parse(args.artifactId),
        contentHash: args.contentHash,
        artifactType: "patch_diff" as const
      }
    });
  }

  public async requestTestsRun(
    trusted: HostRequestTrustedContext,
    rawArgs: unknown
  ): Promise<HostToolSuccessResult> {
    const args = RequestTestsRunArgsSchema.parse(rawArgs);
    return this.createBlockingAction(trusted, "request_tests_run", args, {
      actionType: "tests.run",
      parameters: { profile: args.profileName }
    });
  }

  public async requestProcessExecution(
    trusted: HostRequestTrustedContext,
    rawArgs: unknown
  ): Promise<HostToolSuccessResult> {
    const args = RequestProcessExecutionArgsSchema.parse(rawArgs);
    return this.createBlockingAction(trusted, "request_process_execution", args, {
      actionType: "process.execute",
      parameters: {
        executable: args.executable,
        args: args.args,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {})
      }
    });
  }

  /**
   * Dispatch by tool name — Fake/worker entry. Rejects unknown tools and authority fields
   * via strict per-tool schemas (no owner/approved/controlToken accepted).
   */
  public async invoke(
    toolName: string,
    trusted: HostRequestTrustedContext,
    rawArgs: unknown
  ): Promise<HostToolSuccessResult> {
    switch (toolName) {
      case "request_requester_input":
        return this.requestRequesterInput(trusted, rawArgs);
      case "request_change_proposal":
        return this.requestChangeProposal(trusted, rawArgs);
      case "request_repository_edit":
        return this.requestRepositoryEdit(trusted, rawArgs);
      case "request_tests_run":
        return this.requestTestsRun(trusted, rawArgs);
      case "request_process_execution":
        return this.requestProcessExecution(trusted, rawArgs);
      default:
        throw createPairMeshError({
          code: "pairmesh.host_tool_invalid",
          message: `Unknown host request tool: ${toolName}`,
          details: { toolName }
        });
    }
  }

  private parseTrusted(trusted: HostRequestTrustedContext): HostRequestTrustedContext {
    return HostRequestTrustedContextSchema.parse({
      ...trusted,
      taskId: CollaborativeTaskIdSchema.parse(trusted.taskId),
      sessionId: SessionIdSchema.parse(trusted.sessionId),
      requesterParticipantId: PeerIdSchema.parse(trusted.requesterParticipantId),
      ownerParticipantId: PeerIdSchema.parse(trusted.ownerParticipantId),
      hostToolCallId: HostToolCallIdSchema.parse(trusted.hostToolCallId),
      ...(trusted.providerTurnId
        ? { providerTurnId: ProviderTurnIdSchema.parse(trusted.providerTurnId) }
        : {})
    });
  }

  private async lookupIdempotent(
    context: HostRequestTrustedContext,
    toolName: PairMeshHostRequestToolName,
    digest: string
  ): Promise<HostToolCallRecord | null> {
    const state = await this.stateStore.load();
    if (!state) {
      return null;
    }
    const prior = findHostCall(state, context.hostToolCallId);
    if (!prior) {
      return null;
    }
    if (
      prior.toolName !== toolName ||
      prior.taskId !== context.taskId ||
      prior.argsDigest !== digest
    ) {
      throw createPairMeshError({
        code: "pairmesh.host_tool_conflict",
        message: "hostToolCallId was previously used with conflicting tool/args.",
        details: {
          hostToolCallId: context.hostToolCallId,
          priorTool: prior.toolName,
          toolName,
          priorArgsDigest: prior.argsDigest,
          argsDigest: digest
        }
      });
    }
    return prior;
  }

  private assertTrustedMatchesTask(
    state: LocalSessionState,
    context: HostRequestTrustedContext
  ): void {
    const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === context.taskId);
    if (!task) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_not_found",
        message: `CollaborativeTask ${context.taskId} not found.`,
        details: { taskId: context.taskId }
      });
    }
    if (task.sessionId !== context.sessionId) {
      throw createPairMeshError({
        code: "pairmesh.host_tool_invalid",
        message: "Trusted sessionId does not match CollaborativeTask.",
        details: { taskId: context.taskId }
      });
    }
    if (task.requesterParticipantId !== context.requesterParticipantId) {
      throw createPairMeshError({
        code: "pairmesh.host_tool_invalid",
        message: "Trusted requesterParticipantId does not match CollaborativeTask.",
        details: { taskId: context.taskId }
      });
    }
    if (task.ownerParticipantId !== context.ownerParticipantId) {
      throw createPairMeshError({
        code: "pairmesh.host_tool_invalid",
        message: "Trusted ownerParticipantId does not match CollaborativeTask.",
        details: { taskId: context.taskId }
      });
    }
    const localId = state.localParticipant.participant.id;
    if (localId !== context.ownerParticipantId) {
      throw createPairMeshError({
        code: "pairmesh.host_tool_not_allowed",
        message: "Host request tools may only run on the task owner (receiver) runtime.",
        details: { localParticipantId: localId, ownerParticipantId: context.ownerParticipantId }
      });
    }
  }

  private async createBlockingAction(
    trusted: HostRequestTrustedContext,
    toolName: PairMeshHostRequestToolName,
    rawArgsForDigest: unknown,
    action: {
      actionType: string;
      parameters?: Record<string, string | number | boolean | null | string[]>;
      artifactRef?: {
        artifactId: ReturnType<typeof ArtifactIdSchema.parse>;
        contentHash: string;
        artifactType: "patch_diff";
      };
    }
  ): Promise<HostToolSuccessResult> {
    const context = this.parseTrusted(trusted);
    const digest = argsDigest(rawArgsForDigest);
    const prior = await this.lookupIdempotent(context, toolName, digest);
    if (prior) {
      return replaySuccess(prior, toolName);
    }

    return this.stateStore.enqueue(async () => {
      const loaded = await this.stateStore.load();
      if (!loaded) {
        throw createPairMeshError({
          code: "pairmesh.session_not_found",
          message: "No local PairMesh session found."
        });
      }
      let state = loaded;
      assertTaskAcceptsHostRequest(state, context.taskId);
      this.assertTrustedMatchesTask(state, context);

      if (countTaskActions(state, context.taskId) >= COLLABORATIVE_TASK_MAX_CHILD_ACTIONS) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_child_cap",
          message: `CollaborativeTask may link at most ${COLLABORATIVE_TASK_MAX_CHILD_ACTIONS} Actions.`,
          details: { taskId: context.taskId, max: COLLABORATIVE_TASK_MAX_CHILD_ACTIONS }
        });
      }

      const definition = requireActionTypeDefinition(action.actionType);
      if (!state.sessionSecurity) {
        throw createPairMeshError({
          code: "pairmesh.session_requires_repair",
          message: "Session security is required for controlled actions."
        });
      }
      state = {
        ...state,
        sessionSecurity: ensureDefaultGrants(
          state.sessionSecurity,
          PeerIdSchema.parse(context.requesterParticipantId)
        )
      };
      const capabilityPolicy = getGrantPolicy(
        state,
        PeerIdSchema.parse(context.requesterParticipantId),
        definition.capabilityId
      );
      if (capabilityPolicy === "deny") {
        // Fail closed before ActionService create — no denied Action residue.
        throw createPairMeshError({
          code: "pairmesh.action_not_authorized",
          message: `Peer grant denied creation of ${action.actionType}.`,
          details: { actionType: action.actionType, capabilityId: definition.capabilityId }
        });
      }

      const begun = await this.actionService.beginRequestAction(state, {
        requesterParticipantId: PeerIdSchema.parse(context.requesterParticipantId),
        targetParticipantId: PeerIdSchema.parse(context.ownerParticipantId),
        actionType: action.actionType,
        parameters: action.parameters,
        artifactRef: action.artifactRef,
        deferExecution: true,
        taskId: context.taskId,
        ...(context.providerTurnId ? { originProviderTurnId: context.providerTurnId } : {}),
        originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE
      });

      state = begun.state;

      if (begun.execution.status === "denied") {
        // Should be unreachable after pre-check; refuse linkage and do not claim success.
        throw createPairMeshError({
          code: "pairmesh.action_not_authorized",
          message: `Peer grant denied creation of ${action.actionType}.`,
          details: {
            actionType: action.actionType,
            actionId: begun.execution.actionId,
            status: begun.execution.status
          }
        });
      }

      if (begun.resume) {
        // deferExecution must never start provider work.
        throw createPairMeshError({
          code: "pairmesh.internal_error",
          message: "Host request bridge refused auto-execution resume (deferExecution violated)."
        });
      }

      if (begun.execution.status !== "approval_required" && begun.execution.status !== "approved") {
        await this.stateStore.writeExclusive(state);
        throw createPairMeshError({
          code: "pairmesh.host_tool_invalid",
          message: `Unexpected Action status after host create: ${begun.execution.status}`,
          details: { actionId: begun.execution.actionId, status: begun.execution.status }
        });
      }

      // Link task → blocked_on_action in the same persistence save as Action create.
      const eventId = mintCollaborativeTaskEventId();
      state = this.linkBlockedActionInState(
        state,
        context.taskId,
        begun.execution.actionId,
        eventId
      );

      rememberHostCall(
        state,
        HostToolCallRecordSchema.parse({
          hostToolCallId: context.hostToolCallId,
          taskId: context.taskId,
          toolName,
          argsDigest: digest,
          outcome: "action",
          actionId: begun.execution.actionId,
          createdAt: begun.execution.createdAt
        })
      );

      await this.stateStore.writeExclusive(state);

      return {
        status: "waiting_for_owner" as const,
        actionId: begun.execution.actionId,
        taskId: context.taskId,
        hostToolCallId: context.hostToolCallId
      };
    });
  }

  private linkBlockedActionInState(
    state: LocalSessionState,
    taskId: string,
    actionId: string,
    eventId: string
  ): LocalSessionState {
    const idx = (state.collaborativeTasks ?? []).findIndex((entry) => entry.taskId === taskId);
    if (idx < 0) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_not_found",
        message: `CollaborativeTask ${taskId} not found.`
      });
    }
    const task = state.collaborativeTasks![idx]!;
    const at = new Date().toISOString();
    if (task.status !== "working") {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invalid_transition",
        message: `Cannot block task in status ${task.status}`
      });
    }
    const appliedEvents = task.appliedEvents.some((e) => e.eventId === eventId)
      ? task.appliedEvents
      : [...task.appliedEvents, { eventId, type: "block_on_action" as const }];
    const childRefs = task.childRefs.some((r) => r.id === actionId)
      ? task.childRefs
      : [...task.childRefs, { kind: "action" as const, id: actionId, at }];
    const next = CollaborativeTaskSchema.parse({
      ...task,
      status: "blocked_on_action",
      blockedOnActionId: actionId,
      pendingInputRequestId: undefined,
      childRefs,
      appliedEvents,
      lastAppliedEventId: eventId,
      updatedAt: at
    });
    const collaborativeTasks = [...(state.collaborativeTasks ?? [])];
    collaborativeTasks[idx] = next;
    return { ...state, collaborativeTasks };
  }
}

export function mintHostToolCallId(): string {
  return `htc_${randomUUID()}`;
}
