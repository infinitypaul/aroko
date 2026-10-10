import { PAIRMESH_BUILD_ID, PAIRMESH_BUILD_TIMESTAMP, PAIRMESH_VERSION } from "../build-info.js";
import { listCapabilityRegistry, resolveInviteInitialGrants } from "../auth/capabilities.js";
import { createJoinCommand } from "../pairing/join-command.js";
import { requireActiveRuntime } from "../pairing/active-runtime.js";
import { readRuntimeInfo } from "../local-config/runtime-info.js";
import { loadConfigFile } from "../local-config/resolver.js";
import { configFilePath } from "../local-config/paths.js";
import { SessionManager } from "../session/manager.js";
import {
  createPairMeshError,
  isTerminalCollaborativeTaskStatus,
  type CapabilityGrantPolicy,
  type CollaborativeTask
} from "@pairmesh/protocol";
import type {
  ControlCapabilityDefinitionView,
  ControlInviteResult,
  ControlJoinInput,
  ControlPeerView,
  ControlPermissionsView,
  ControlStatusView
} from "./types.js";
import {
  enrichActionForControlInbox,
  formatCodingAgentProviderDisplayName
} from "./action-inbox.js";
import type { ReceiverActionListFilter } from "../session/receiver-actions.js";
import type { ReceiverInspectionListFilter } from "../session/receiver-inspections.js";
import { enrichInspectionForWatch } from "../action/watch-present.js";
import { CONTROL_API_SCHEMA_VERSION } from "../local-runtime/runtime-identity.js";
import { evaluateRuntimeBusy, type RuntimeBusySnapshot } from "../local-runtime/runtime-idle.js";
import { readDeferredRestart } from "../local-runtime/deferred-restart.js";
import { loadReliabilitySummary } from "../reliability/summary.js";
import {
  projectCollaborativeTaskHistory,
  projectCollaborativeTaskProgress,
  summarizeGoal,
  type CollaborativeTaskViewerRole,
  type DeriveTaskProgressInput,
  type SafeParticipantLabel
} from "../collaboration/task-progress-present.js";
import type { LocalSessionState } from "../session/schemas.js";

export interface ControlPlaneOptions {
  sessionManager: SessionManager;
  /** Project workspace root (for runtime.json / advertise URL). */
  workspace?: string;
  relayBridge?: import("../connectivity/relay-bridge.js").RelayBridge;
}

/**
 * Provider-neutral human administration facade over SessionManager.
 * Used by the localhost Control HTTP API and CLI — never by MCP.
 */
export class ControlPlane {
  private readonly manager: SessionManager;
  private readonly workspace?: string;
  private readonly relayBridge?: import("../connectivity/relay-bridge.js").RelayBridge;

  public constructor(options: ControlPlaneOptions) {
    this.manager = options.sessionManager;
    this.workspace = options.workspace;
    this.relayBridge = options.relayBridge;
  }

  public listCapabilities(): ControlCapabilityDefinitionView[] {
    return listCapabilityRegistry().map((entry) => ({
      id: entry.id,
      risk: entry.risk,
      description: entry.description,
      defaultPolicy: entry.defaultPolicy
    }));
  }

  public async getStatus(): Promise<ControlStatusView> {
    const runtimeInfo = this.workspace ? await readRuntimeInfo(this.workspace) : null;
    let sessionPresent = false;
    let statusView: Awaited<ReturnType<SessionManager["getSessionStatus"]>> | null = null;
    try {
      statusView = await this.manager.getSessionStatus();
      sessionPresent = true;
    } catch {
      sessionPresent = false;
    }

    let projectId = runtimeInfo?.projectId;
    let codingAgentProvider: string | undefined;
    if (this.workspace) {
      try {
        const config = await loadConfigFile(configFilePath(this.workspace));
        projectId = config.projectId;
        codingAgentProvider = config.codingAgent.provider;
      } catch {
        // optional
      }
    }

    const busy = await this.getRuntimeBusy();
    const deferred = this.workspace ? await readDeferredRestart(this.workspace) : null;
    const reliability = this.workspace ? await loadReliabilitySummary(this.workspace) : undefined;

    return {
      version: PAIRMESH_VERSION,
      buildId: PAIRMESH_BUILD_ID,
      buildTimestamp: PAIRMESH_BUILD_TIMESTAMP,
      controlApiSchemaVersion: CONTROL_API_SCHEMA_VERSION,
      ...(projectId ? { projectId } : {}),
      ...(this.workspace ? { workspace: this.workspace } : {}),
      runtime: {
        running: Boolean(runtimeInfo),
        ...(runtimeInfo?.controlUrl ? { controlUrl: runtimeInfo.controlUrl } : {}),
        ...(runtimeInfo?.baseUrl ? { a2aBaseUrl: runtimeInfo.baseUrl } : {}),
        ...(runtimeInfo?.advertisedUrl ? { advertisedUrl: runtimeInfo.advertisedUrl } : {}),
        ...(runtimeInfo?.bindHost ? { bindHost: runtimeInfo.bindHost } : {}),
        ...(runtimeInfo?.agentName ? { agentName: runtimeInfo.agentName } : {}),
        ...(runtimeInfo?.mode ? { mode: runtimeInfo.mode } : {}),
        idle: busy.idle,
        ...(busy.busyReasons.length > 0 ? { busyReasons: busy.busyReasons } : {})
      },
      session: {
        present: sessionPresent,
        authenticated: statusView?.security.authenticated === true,
        peerCount: statusView?.peers.length ?? 0,
        ...(statusView
          ? {
              sessionCode: statusView.sessionCode,
              sessionId: statusView.sessionId,
              status: statusView.status,
              localAgent: statusView.localParticipant.agent.name
            }
          : {})
      },
      ...(codingAgentProvider
        ? {
            codingAgent: {
              provider: codingAgentProvider
            }
          }
        : {}),
      ...(deferred
        ? {
            deferredRestart: {
              pending: true,
              targetBuildId: deferred.targetBuildId
            }
          }
        : { deferredRestart: { pending: false } }),
      ...(reliability && Object.keys(reliability).length > 0 ? { reliability } : {})
    };
  }

    public async getRuntimeBusy(): Promise<RuntimeBusySnapshot> {
    let actions: Array<{ status?: string; terminal?: boolean }> = [];
    let inspections: Array<{ status?: string; terminal?: boolean }> = [];
    try {
      actions = await this.listActions("active", 100);
    } catch {
      actions = [];
    }
    try {
      inspections = await this.listInspections("active", 100);
    } catch {
      inspections = [];
    }
    return evaluateRuntimeBusy({ actions, inspections });
  }

  public async listPeers(): Promise<ControlPeerView[]> {
    const status = await this.manager.getSessionStatus();
    const safePeers = await this.manager.listSafePeers();
    const rows = await this.manager.listPeerPermissions();
    const peers: ControlPeerView[] = [];
    for (const row of rows) {
      const peerRecord = status.peers.find((p) => p.participant.id === row.participantId);
      const safe = safePeers.find((entry) => entry.participantId === row.participantId);
      let health: ControlPeerView["health"];
      try {
        const result = await this.manager.getPeerHealth(row.participantId);
        health = result.reachable
          ? {
              reachable: true,
              status: result.pairmesh.status,
              readyForInspection: result.pairmesh.status === "ready" && safe?.agent === "ready"
            }
          : { reachable: false };
      } catch {
        health = { reachable: false };
      }
      peers.push({
        peer: row.peer,
        participantId: row.participantId,
        displayName: safe?.displayName ?? peerRecord?.developer.displayName ?? row.peer,
        ...(safe?.service ? { service: safe.service } : {}),
        relationship: safe?.relationship ?? "unpaired",
        ...(safe?.connectivity ? { connectivity: safe.connectivity } : {}),
        ...(safe?.agent ? { agent: safe.agent } : {}),
        ...(peerRecord ? { agentUrl: peerRecord.a2aAgentUrl } : {}),
        ...(health ? { health } : {}),
        grants: row.grants.map((grant) => ({
          capabilityId: grant.capabilityId,
          policy: grant.policy,
          updatedAt: grant.updatedAt
        }))
      });
    }
    return peers;
  }

  public async getPermissions(): Promise<ControlPermissionsView> {
    const peers = await this.listPeers();
    const pendingRaw = await this.manager.listPendingPermissions();
    let actionExecutions: Awaited<ReturnType<SessionManager["listPendingActions"]>> = [];
    try {
      actionExecutions = await this.manager.listPendingActions();
    } catch {
      actionExecutions = [];
    }
    const pending = pendingRaw.map((request) => {
      const peer = peers.find((entry) => entry.participantId === request.participantId);
      const linkedAction = actionExecutions.find(
        (action) =>
          action.permissionRequestId === request.permissionRequestId ||
          action.actionId === request.correlationRequestId
      );
      return {
        permissionRequestId: request.permissionRequestId,
        participantId: request.participantId,
        ...(peer
          ? {
              peerName: peer.peer,
              displayName: peer.displayName,
              ...(peer.service ? { service: peer.service } : {})
            }
          : {}),
        capabilityId: request.capabilityId,
        correlationRequestId: request.correlationRequestId,
        ...(request.threadId ? { threadId: request.threadId } : {}),
        ...(linkedAction?.actionType ? { actionType: linkedAction.actionType } : {}),
        status: request.status,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt
      };
    });
    return { peers, pending };
  }

  public async createInvite(input?: {
    initialGrants?: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>;
  }): Promise<ControlInviteResult> {
    const resolved = resolveInviteInitialGrants(input?.initialGrants);
    try {
      await this.manager.getSessionStatus();
    } catch {
      throw createPairMeshError({
        code: "pairmesh.session_not_found",
        message: "No active PairMesh session. Create a session before inviting."
      });
    }

    const invite = await this.manager.createSessionInvite({ initialGrants: resolved });
    const peerUrl = await this.resolvePeerUrlForInvite();
    const join = createJoinCommand({
      sessionCode: invite.sessionCode,
      peerUrl,
      inviteSecret: invite.inviteSecret
    });

    return {
      sessionCode: invite.sessionCode,
      inviteSecret: invite.inviteSecret,
      expiresAt: invite.expiresAt,
      joinCommand: join.joinCommand,
      peerUrl,
      initialGrants: resolved
    };
  }

  public async createSessionWithInvite(input: {
    name: string;
    agentUrl: string;
    initialGrants?: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>;
  }): Promise<ControlInviteResult> {
    const resolved = resolveInviteInitialGrants(input.initialGrants);
    const created = await this.manager.createSession({
      name: input.name,
      agentUrl: input.agentUrl,
      initialGrants: resolved
    });
    const peerUrl = await this.resolvePeerUrlForInvite();
    const join = createJoinCommand({
      sessionCode: created.invite.sessionCode,
      peerUrl,
      inviteSecret: created.invite.inviteSecret
    });
    return {
      sessionCode: created.invite.sessionCode,
      inviteSecret: created.invite.inviteSecret,
      expiresAt: created.invite.expiresAt,
      joinCommand: join.joinCommand,
      peerUrl,
      initialGrants: resolved
    };
  }

  public async join(input: ControlJoinInput): Promise<ControlStatusView> {
    const parsed = parseJoinInput(input);
    const runtime = this.workspace
      ? await requireActiveRuntime(this.workspace).catch(() => null)
      : null;
    const name = input.name?.trim() || runtime?.runtimeInfo.agentName || "pairmesh-agent";
    const agentUrl =
      input.agentUrl?.trim() || runtime?.runtimeInfo.advertisedUrl || runtime?.runtimeInfo.baseUrl;
    if (!agentUrl) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "agentUrl is required to join (or start PairMesh runtime first)."
      });
    }
    await this.manager.joinSession({
      sessionCode: parsed.sessionCode,
      peerUrl: parsed.peerUrl!,
      inviteSecret: parsed.inviteSecret,
      name,
      agentUrl
    });
    return this.getStatus();
  }

  public async setPeerCapability(
    peer: string,
    capabilityId: string,
    policy: CapabilityGrantPolicy
  ): Promise<{ peer: string; capabilityId: string; policy: CapabilityGrantPolicy }> {
    return this.manager.setPeerCapability(peer, capabilityId, policy);
  }

  public async decidePermission(
    permissionRequestId: string,
    decision: "allow-once" | "allow-session" | "deny"
  ) {
    return this.manager.decidePendingPermission(permissionRequestId, decision);
  }

  public async listPendingActions() {
    const codingAgentProvider = await this.resolveCodingAgentProviderId();
    const views = await this.manager.listPendingActions();
    return views.map((view) =>
      enrichActionForControlInbox(view, { codingAgentProviderId: codingAgentProvider })
    );
  }

  public async listActions(filter: ReceiverActionListFilter = "all", limit = 50) {
    const codingAgentProvider = await this.resolveCodingAgentProviderId();
    const views = await this.manager.listReceiverActions(filter, limit);
    return views.map((view) =>
      enrichActionForControlInbox(view, { codingAgentProviderId: codingAgentProvider })
    );
  }

  public async listInspections(filter: ReceiverInspectionListFilter = "all", limit = 50) {
    const codingAgentProvider = await this.resolveCodingAgentProviderId();
    const views = await this.manager.listReceiverInspections(filter, limit);
    return views.map((view) =>
      enrichInspectionForWatch(view, { codingAgentProviderId: codingAgentProvider })
    );
  }

  public async getAction(actionId: string) {
    const view = await this.manager.getAction(actionId);
    const codingAgentProvider = await this.resolveCodingAgentProviderId();
    return enrichActionForControlInbox(view, { codingAgentProviderId: codingAgentProvider });
  }

  /**
   * R5-7 — CollaborativeTask progress list for Control (active / recent / all).
   * Compact JSON-safe projections only (no appliedEvents / tokens).
   */
  public async listCollaborativeTasks(filter: "active" | "recent" | "all" = "active", limit = 50) {
    // R5-8-D3: heal blocked_on_action tasks whose Actions already completed.
    try {
      await this.manager.reconcileCollaborativeActionContinuations();
    } catch {
      // Listing must still succeed if reconcile fails.
    }
    const state = await this.manager.readActiveSessionState();
    const taskService = this.manager.getCollaborativeTaskService();
    const localId = state.localParticipant.participant.id;
    let tasks = (await taskService.listTasks()).filter(
      (task) => task.ownerParticipantId === localId || task.requesterParticipantId === localId
    );

    if (filter === "active") {
      tasks = tasks.filter((task) => !isTerminalCollaborativeTaskStatus(task.status));
      tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } else if (filter === "recent") {
      tasks = tasks.filter((task) => isTerminalCollaborativeTaskStatus(task.status));
      tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } else {
      tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    const capped = Math.min(Math.max(limit, 1), 200);
    const providerDisplayName = await this.resolveProviderDisplayNameForTasks();
    return tasks
      .slice(0, capped)
      .map((task) =>
        projectCollaborativeTaskProgress(
          this.buildTaskProgressInput(state, task, localId, providerDisplayName)
        )
      );
  }

  /** R5-7 — single CollaborativeTask progress projection. */
  public async getCollaborativeTask(taskId: string) {
    const state = await this.manager.readActiveSessionState();
    const taskService = this.manager.getCollaborativeTaskService();
    const task = await taskService.getTask(taskId);
    if (!task) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_not_found",
        message: "CollaborativeTask not found.",
        details: { taskId }
      });
    }
    const localId = state.localParticipant.participant.id;
    if (task.ownerParticipantId !== localId && task.requesterParticipantId !== localId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_not_found",
        message: "CollaborativeTask not found.",
        details: { taskId }
      });
    }
    const providerDisplayName = await this.resolveProviderDisplayNameForTasks();
    return projectCollaborativeTaskProgress(
      this.buildTaskProgressInput(state, task, localId, providerDisplayName)
    );
  }

  /** R5-7 — CollaborativeTask history / timeline projection. */
  public async getCollaborativeTaskHistory(taskId: string) {
    const state = await this.manager.readActiveSessionState();
    const taskService = this.manager.getCollaborativeTaskService();
    const task = await taskService.getTask(taskId);
    if (!task) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_not_found",
        message: "CollaborativeTask not found.",
        details: { taskId }
      });
    }
    const localId = state.localParticipant.participant.id;
    if (task.ownerParticipantId !== localId && task.requesterParticipantId !== localId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_not_found",
        message: "CollaborativeTask not found.",
        details: { taskId }
      });
    }
    const providerDisplayName = await this.resolveProviderDisplayNameForTasks();
    return projectCollaborativeTaskHistory(
      this.buildTaskProgressInput(state, task, localId, providerDisplayName)
    );
  }

  /**
   * R5-7 — InputRequests pending for the local participant as requester
   * (Answer semantics — never Approve).
   */
  public async listPendingRequesterInputs() {
    const state = await this.manager.readActiveSessionState();
    const taskService = this.manager.getCollaborativeTaskService();
    const inputService = this.manager.getInputRequestService();
    const localId = state.localParticipant.participant.id;
    const pending = await inputService.listInputRequests({ status: "pending" });
    const tasks = await taskService.listTasks();
    const byId = new Map(tasks.map((task) => [task.taskId, task]));

    return pending
      .filter((input) => {
        const task = byId.get(input.taskId);
        return task?.requesterParticipantId === localId;
      })
      .map((input) => {
        const view = inputService.toRequesterView(input);
        const task = byId.get(input.taskId);
        const owner = task ? resolveParticipantLabel(state, task.ownerParticipantId) : undefined;
        return {
          ...view,
          interaction: "answer" as const,
          ...(task ? { goalSummary: summarizeGoal(task.originalGoal) } : {}),
          ...(owner ? { owner } : {})
        };
      });
  }

  /**
   * R5-7 — Answer a pending requester InputRequest from Control Center.
   * Answer semantics only — never Approve/Deny Action decisions.
   */
  public async answerRequesterInput(
    inputRequestId: string,
    input: { answer: string; taskId?: string }
  ) {
    const result = await this.manager.answerCollaborativeInputRequest({
      inputRequestId,
      answer: input.answer,
      ...(input.taskId ? { taskId: input.taskId } : {})
    });
    const state = await this.manager.readActiveSessionState();
    const localId = state.localParticipant.participant.id;
    const task = result.task;
    const inputService = this.manager.getInputRequestService();
    const inputRequest = result.inputRequest
      ? inputService.toRequesterView(result.inputRequest)
      : null;
    return {
      interaction: "answer" as const,
      ...(inputRequest ? { inputRequest } : {}),
      ...(task && (task.ownerParticipantId === localId || task.requesterParticipantId === localId)
        ? {
            task: projectCollaborativeTaskProgress(
              this.buildTaskProgressInput(
                state,
                task,
                localId,
                await this.resolveProviderDisplayNameForTasks()
              )
            )
          }
        : {})
    };
  }

  public async getInspection(requestId: string) {
    const view = await this.manager.getInspection(requestId);
    const codingAgentProvider = await this.resolveCodingAgentProviderId();
    return enrichInspectionForWatch(view, { codingAgentProviderId: codingAgentProvider });
  }

  public async reviewActionProposal(actionId: string) {
    return this.manager.reviewActionProposal(actionId);
  }

  public async approveAction(actionId: string, decision: "allow-once" | "allow-session" | "deny") {
    const view = await this.manager.approveAction(actionId, decision);
    const codingAgentProvider = await this.resolveCodingAgentProviderId();
    return enrichActionForControlInbox(view, { codingAgentProviderId: codingAgentProvider });
  }

  public async denyAction(actionId: string) {
    return this.manager.denyAction(actionId);
  }

  public async removePeer(peer: string) {
    return this.manager.removePeer(peer);
  }

  public async leave() {
    await this.manager.leaveSession();
    await this.relayBridge?.stop({ clearPersisted: true });
    return { left: true };
  }

  public getRelayTrafficTrace():
    import("../connectivity/relay/traffic-trace.js").RelayTrafficSnapshot | { mode: "off" } {
    if (!this.relayBridge) return { mode: "off" };
    return this.relayBridge.getTrafficTrace();
  }

  public resetRelayTrafficTrace(canaries?: string[]): void {
    this.relayBridge?.resetTrafficTrace(canaries);
  }

  public getRelayStatus():
    import("../connectivity/relay-bridge.js").RelayBridgeStatus | { mode: "off" } {
    if (!this.relayBridge) return { mode: "off" };
    return this.relayBridge.getStatus();
  }

  public async startRelayCreator(input: {
    relayWsUrl: string;
    sessionCode: string;
    inviteSecret: string;
  }): Promise<import("../connectivity/relay-bridge.js").RelayBridgeStatus> {
    if (!this.relayBridge) {
      throw createPairMeshError({
        code: "pairmesh.relay_unavailable",
        message: "Relay bridge is not available in this runtime."
      });
    }
    const runtimeInfo = this.workspace ? await readRuntimeInfo(this.workspace) : null;
    const localA2aBaseUrl = runtimeInfo?.baseUrl;
    if (!localA2aBaseUrl) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "Runtime A2A base URL is required to start relay."
      });
    }
    return this.relayBridge.startCreator({
      ...input,
      localA2aBaseUrl
    });
  }

  public async startRelayJoiner(input: {
    relayWsUrl: string;
    sessionCode: string;
    inviteSecret: string;
  }): Promise<import("../connectivity/relay-bridge.js").RelayBridgeStatus> {
    if (!this.relayBridge) {
      throw createPairMeshError({
        code: "pairmesh.relay_unavailable",
        message: "Relay bridge is not available in this runtime."
      });
    }
    const runtimeInfo = this.workspace ? await readRuntimeInfo(this.workspace) : null;
    const localA2aBaseUrl = runtimeInfo?.baseUrl;
    if (!localA2aBaseUrl) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "Runtime A2A base URL is required to start relay."
      });
    }
    return this.relayBridge.startJoiner({
      ...input,
      localA2aBaseUrl
    });
  }

  public async listAudit(limit = 50) {
    await this.manager.flushAudit();
    const events = await this.manager.listAuditEvents(limit);
    return events.map(sanitizeAuditEvent);
  }

  private async resolveCodingAgentProviderId(): Promise<string | undefined> {
    if (!this.workspace) {
      return undefined;
    }
    try {
      const config = await loadConfigFile(configFilePath(this.workspace));
      return config.codingAgent.provider;
    } catch {
      return undefined;
    }
  }

  private async resolveProviderDisplayNameForTasks(): Promise<string | undefined> {
    const providerId = await this.resolveCodingAgentProviderId();
    return providerId ? formatCodingAgentProviderDisplayName(providerId) : undefined;
  }

  private buildTaskProgressInput(
    state: LocalSessionState,
    task: CollaborativeTask,
    localId: string,
    providerDisplayName?: string
  ): DeriveTaskProgressInput {
    const viewerRole: CollaborativeTaskViewerRole =
      localId === task.ownerParticipantId ? "owner" : "requester";
    const taskId = task.taskId;
    return {
      task,
      viewerRole,
      requester: resolveParticipantLabel(state, task.requesterParticipantId),
      owner: resolveParticipantLabel(state, task.ownerParticipantId),
      inputRequests: (state.inputRequests ?? []).filter((entry) => entry.taskId === taskId),
      actions: (state.actionExecutions ?? []).filter((entry) => entry.taskId === taskId),
      providerTurns: (state.providerTurns ?? []).filter((entry) => entry.taskId === taskId),
      continuationEvents: (state.continuationEvents ?? []).filter(
        (entry) => entry.taskId === taskId
      ),
      ...(providerDisplayName ? { providerDisplayName } : {})
    };
  }

  private async resolvePeerUrlForInvite(): Promise<string> {
    if (this.workspace) {
      try {
        const active = await requireActiveRuntime(this.workspace);
        return active.peerUrl;
      } catch {
        // fall through
      }
    }
    const status = await this.manager.getSessionStatus();
    return status.localParticipant.a2aAgentUrl;
  }
}

function sanitizeAuditEvent(event: Awaited<ReturnType<SessionManager["listAuditEvents"]>>[number]) {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    recordedAt: event.timestamp,
    sessionCode: event.sessionCode,
    actor: event.actor,
    target: event.target,
    correlation: event.correlation,
    metadata: event.metadata
  };
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

export function parseJoinInput(input: ControlJoinInput): {
  sessionCode: string;
  peerUrl?: string;
  inviteSecret: string;
} {
  if (input.joinCommand?.trim()) {
    return parseJoinCommand(input.joinCommand.trim());
  }
  const sessionCode = input.sessionCode?.trim();
  const peerUrl = input.peerUrl?.trim();
  const inviteSecret = input.inviteSecret?.trim();
  if (!sessionCode || !inviteSecret) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Join requires sessionCode and inviteSecret (or a joinCommand string)."
    });
  }
  return { sessionCode, ...(peerUrl ? { peerUrl } : {}), inviteSecret };
}

export function parseJoinCommand(command: string): {
  sessionCode: string;
  peerUrl?: string;
  inviteSecret: string;
} {
  const tokens = command.trim().split(/\s+/);
  const joinIdx = tokens.findIndex((token) => token === "join");
  if (joinIdx < 0 || !tokens[joinIdx + 1]) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message:
        "Could not parse join command. Expected: aroko join <code> --invite <secret> [--peer <url>]"
    });
  }
  const sessionCode = tokens[joinIdx + 1]!;
  let peerUrl = "";
  let inviteSecret = "";
  for (let i = joinIdx + 2; i < tokens.length; i += 1) {
    if (tokens[i] === "--peer" && tokens[i + 1]) {
      peerUrl = tokens[i + 1]!;
      i += 1;
    } else if (tokens[i] === "--invite" && tokens[i + 1]) {
      inviteSecret = tokens[i + 1]!;
      i += 1;
    }
  }
  if (!inviteSecret) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Join command must include --invite."
    });
  }
  return {
    sessionCode,
    ...(peerUrl ? { peerUrl } : {}),
    inviteSecret
  };
}
