import {
  ActionExecutionRecordSchema,
  createPairMeshError,
  type ActionArtifactRef,
  type ActionExecutionRecord,
  type ActionId,
  type ActionParameters,
  type PairMeshActionWireSuccessResponse,
  type PeerId,
  type ProgressEvent
} from "@pairmesh/protocol";
import type { LocalParticipantRecord, LocalSessionState } from "../session/schemas.js";
import { toSafePeerMeta, type SafePeerMeta } from "../session/peer-view.js";
import { digestParameters } from "./digest.js";
import { getActionTypeDefinition } from "./registry.js";
import { isTerminalActionStatus } from "./lifecycle.js";
import { mergeMirroredActionProgress, projectProgressForViewer } from "./progress.js";
import { resolveStoredProviderDisplayName } from "../execution/provider-snapshot.js";
import {
  projectOwnerProcessExecution,
  type OwnerProcessExecutionView
} from "./process/owner-projection.js";

export interface ActionSafeView {
  actionId: ActionId;
  status: ActionExecutionRecord["status"];
  actionType: string;
  capabilityId: string;
  requesterParticipantId: PeerId;
  targetParticipantId: PeerId;
  permissionRequestId?: string;
  artifactRefs?: ActionArtifactRef[];
  paths?: string[];
  summary?: string;
  message?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outputs?: Record<string, string | number | boolean | null>;
  error?: { code: string; message: string };
  peer?: SafePeerMeta;
  terminal: boolean;
    progress: ProgressEvent[];
  latestProgress?: ProgressEvent;
  /** Immutable snapshot from execution record when present. */
  providerDisplayName?: string;
  executionProviderId?: string;
  /**
   * Owner/receiver-only process.execute approval projection (R4-M1).
   * Never attached for the requester viewer; never includes absolute paths or env.
   */
  processExecution?: OwnerProcessExecutionView;
  /** True when process.execute is pending but owner-safe details are missing. */
  processApprovalDisplayUnavailable?: boolean;
  /** R5-7 — CollaborativeTask linkage when Action was created from goal-mode host tools. */
  taskId?: string;
  originProviderTurnId?: string;
  originProvenance?: string;
}

export function toActionSafeView(
  state: LocalSessionState,
  execution: ActionExecutionRecord
): ActionSafeView {
  const peerRecord = resolveActionPeer(state, execution);
  const progressView = projectProgressForViewer(state, execution);
  const providerDisplayName = resolveStoredProviderDisplayName(execution);
  const localId = state.localParticipant.participant.id;
  const isOwnerReceiver = execution.targetParticipantId === localId;
  const processExecution =
    isOwnerReceiver && execution.actionType === "process.execute"
      ? projectOwnerProcessExecution(execution)
      : null;
  const processApprovalDisplayUnavailable =
    isOwnerReceiver &&
    execution.actionType === "process.execute" &&
    execution.status === "approval_required" &&
    processExecution === null;

  return {
    actionId: execution.actionId,
    status: execution.status,
    actionType: execution.actionType,
    capabilityId: execution.capabilityId,
    requesterParticipantId: execution.requesterParticipantId,
    targetParticipantId: execution.targetParticipantId,
    ...(execution.permissionRequestId
      ? { permissionRequestId: execution.permissionRequestId }
      : {}),
    ...(execution.artifactRefs?.length ? { artifactRefs: execution.artifactRefs } : {}),
    ...(execution.approvalBinding?.normalizedTargetPaths?.length
      ? { paths: execution.approvalBinding.normalizedTargetPaths }
      : {}),
    ...(execution.result?.summary ? { summary: execution.result.summary } : {}),
    ...(execution.approvalBinding?.expiresAt
      ? { expiresAt: execution.approvalBinding.expiresAt }
      : {}),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
    ...(execution.result?.outputs ? { outputs: execution.result.outputs } : {}),
    ...((execution.result?.error ?? execution.error)
      ? { error: execution.result?.error ?? execution.error }
      : {}),
    ...(peerRecord ? { peer: toSafePeerMeta(peerRecord) } : {}),
    terminal: isTerminalActionStatus(execution.status),
    progress: progressView.progress,
    ...(progressView.latestProgress ? { latestProgress: progressView.latestProgress } : {}),
    ...(providerDisplayName ? { providerDisplayName } : {}),
    ...(execution.executionProviderId
      ? { executionProviderId: execution.executionProviderId }
      : {}),
    ...(processExecution ? { processExecution } : {}),
    ...(processApprovalDisplayUnavailable ? { processApprovalDisplayUnavailable: true } : {}),
    ...(execution.taskId ? { taskId: execution.taskId } : {}),
    ...(execution.originProviderTurnId
      ? { originProviderTurnId: execution.originProviderTurnId }
      : {}),
    ...(execution.originProvenance ? { originProvenance: execution.originProvenance } : {})
  };
}

export function listPendingActionExecutions(state: LocalSessionState): ActionExecutionRecord[] {
  const localId = state.localParticipant.participant.id;
  return (state.actionExecutions ?? []).filter(
    (entry) => entry.status === "approval_required" && entry.targetParticipantId === localId
  );
}

export function findActionExecution(
  state: LocalSessionState,
  actionId: ActionId | string
): ActionExecutionRecord | undefined {
  return (state.actionExecutions ?? []).find((entry) => entry.actionId === actionId);
}

export function findLinkedActionForPermission(
  state: LocalSessionState,
  permissionRequestId: string,
  correlationRequestId?: string
): ActionExecutionRecord | undefined {
  return (state.actionExecutions ?? []).find((entry) => {
    if (entry.status !== "approval_required") {
      return false;
    }
    if (entry.permissionRequestId === permissionRequestId) {
      return true;
    }
    return Boolean(correlationRequestId && entry.actionId === correlationRequestId);
  });
}

export function buildActionMirrorFromWire(
  wire: PairMeshActionWireSuccessResponse,
  context: {
    requesterParticipantId: PeerId;
    targetParticipantId: PeerId;
    parameters?: ActionParameters;
    artifactRef?: ActionArtifactRef;
  }
): ActionExecutionRecord {
  const actionType = wire.actionType;
  if (!actionType) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "Action wire success response is missing actionType for local mirror."
    });
  }
  const definition = getActionTypeDefinition(actionType);
  const parameters = context.parameters ?? {};
  const now = wire.updatedAt ?? wire.createdAt ?? new Date().toISOString();
  const artifactRefs =
    wire.artifactRefs ?? (context.artifactRef ? [context.artifactRef] : undefined);

  return ActionExecutionRecordSchema.parse({
    actionId: wire.actionId,
    requesterParticipantId: wire.requesterParticipantId ?? context.requesterParticipantId,
    targetParticipantId: wire.targetParticipantId ?? context.targetParticipantId,
    actionType,
    capabilityId: wire.capabilityId ?? definition?.capabilityId ?? "change.propose",
    status: wire.status,
    parameters,
    parameterDigest: digestParameters(parameters),
    mutability: definition?.mutability ?? "none",
    createdAt: wire.createdAt ?? now,
    updatedAt: wire.updatedAt ?? now,
    ...(wire.executionStartedAt ? { executionStartedAt: wire.executionStartedAt } : {}),
    ...(wire.completedAt ? { completedAt: wire.completedAt } : {}),
    ...(wire.permissionRequestId ? { permissionRequestId: wire.permissionRequestId } : {}),
    ...(artifactRefs?.length ? { artifactRefs } : {}),
    ...(wire.approvalExpiresAt
      ? {
          approvalBinding: {
            requesterParticipantId: wire.requesterParticipantId ?? context.requesterParticipantId,
            targetParticipantId: wire.targetParticipantId ?? context.targetParticipantId,
            actionId: wire.actionId,
            capabilityId: wire.capabilityId ?? definition?.capabilityId ?? "change.propose",
            actionType,
            parameterDigest: digestParameters(parameters),
            ...(artifactRefs?.[0]
              ? {
                  artifactId: artifactRefs[0].artifactId,
                  artifactContentHash: artifactRefs[0].contentHash
                }
              : {}),
            expiresAt: wire.approvalExpiresAt
          }
        }
      : {}),
    ...(wire.summary || wire.outputs || wire.error || artifactRefs
      ? {
          result: {
            actionId: wire.actionId,
            status: wire.status,
            ...(wire.summary ? { summary: wire.summary } : {}),
            ...(artifactRefs?.length ? { artifactRefs } : {}),
            ...(wire.completedAt ? { completedAt: wire.completedAt } : {}),
            ...(wire.outputs ? { outputs: wire.outputs } : {}),
            ...(wire.error ? { error: wire.error } : {}),
            ...(typeof wire.executorInvocationCount === "number"
              ? { executorInvocationCount: wire.executorInvocationCount }
              : {})
          }
        }
      : {}),
    ...(wire.error && !wire.summary ? { error: wire.error } : {}),
    executorInvocationCount: wire.executorInvocationCount ?? 0
  });
}

export function upsertActionExecution(
  state: LocalSessionState,
  execution: ActionExecutionRecord
): LocalSessionState {
  return {
    ...state,
    actionExecutions: [
      ...(state.actionExecutions ?? []).filter((entry) => entry.actionId !== execution.actionId),
      execution
    ]
  };
}

/**
 * Upsert a requester-side wire mirror while synthesizing/preserving local progress.
 * Progress is never taken from A2A (wire has no progress field).
 */
export function upsertMirroredActionFromWire(
  state: LocalSessionState,
  mirror: ActionExecutionRecord
): { state: LocalSessionState; execution: ActionExecutionRecord } {
  const previous = findActionExecution(state, mirror.actionId);
  const merged = mergeMirroredActionProgress(previous, mirror);
  return {
    state: upsertActionExecution(state, merged),
    execution: merged
  };
}

function resolveActionPeer(
  state: LocalSessionState,
  execution: ActionExecutionRecord
): LocalParticipantRecord | undefined {
  const localId = state.localParticipant.participant.id;
  const peerId =
    execution.requesterParticipantId === localId
      ? execution.targetParticipantId
      : execution.requesterParticipantId;
  return state.peers.find((entry) => entry.participant.id === peerId);
}
