import {
  InspectionExecutionRecordSchema,
  PAIRMESH_METADATA_VERSION,
  PairMeshInspectionFailureResponseSchema,
  PairMeshInspectionSuccessResponseSchema,
  createPairMeshError,
  type PairMeshInspectionRequest,
  type PairMeshInspectionResponse,
  type PairMeshSourceReference,
  type ProgressEvent
} from "@pairmesh/protocol";
import {
  createCodingAgentError,
  isCodingAgentError,
  type CodingAgentAdapter,
  type CodingAgentInspectOptions,
  type CodingAgentRequest
} from "../coding-agent/index.js";
import { LocalStateStore } from "../state/store.js";
import {
  appendInitiatorTurn,
  buildSanitizedTurnContext,
  buildTurnFromRequest,
  buildTurnResult,
  closeThreadRecord,
  createInitiatorThreadRecord,
  findCachedTurnResult,
  findInspectionThread,
  listInspectionThreads,
  nowUtcIso,
  requireInitiatorThread
} from "./thread-store.js";
import {
  cancelActiveInspection,
  clearActiveInspection,
  registerActiveInspection
} from "./active-inspections.js";
import { findExecutionRecord, upsertExecutionRecord } from "./execution-store.js";
import type { LocalSessionState } from "../session/schemas.js";
import { mayIncludeSourceReferences } from "../auth/capabilities.js";
import {
  mapInspectionProgressToProgressEvent,
  mapProviderActivityToProgressEvent
} from "../action/provider-activity.js";
import {
  appendReceiverInspectionProgress,
  createReceiverInspectionExecution
} from "../session/receiver-inspections.js";
import { buildExecutionProviderSnapshot } from "../execution/provider-snapshot.js";

export async function processPairMeshInspectionRequest(
  request: PairMeshInspectionRequest,
  adapter: CodingAgentAdapter,
  stateStore?: LocalStateStore,
  options?: {
    participantId?: string;
        onProgressPersisted?: (events: readonly ProgressEvent[]) => void;
  }
): Promise<PairMeshInspectionResponse> {
  if (stateStore) {
    return await processReceiverInspectionRequest(request, adapter, stateStore, options);
  }

  const invoked = await invokeCodingAgent(request, adapter, buildAdapterRequest(request));
  return invoked.response;
}

export function cancelReceiverInspection(requestId: string): boolean {
  return cancelActiveInspection(requestId);
}

async function processReceiverInspectionRequest(
  request: PairMeshInspectionRequest,
  adapter: CodingAgentAdapter,
  stateStore: LocalStateStore,
  options?: {
    participantId?: string;
    onProgressPersisted?: (events: readonly ProgressEvent[]) => void;
  }
): Promise<PairMeshInspectionResponse> {
  const state = await stateStore.load();
  if (!state || state.session.status !== "active") {
    return failureResponse(request, {
      code: "pairmesh.session_not_found",
      message: "No active PairMesh session on receiving agent."
    });
  }

  if (request.sessionId !== state.session.id) {
    return failureResponse(request, {
      code: "pairmesh.inspection_thread_invalid_state",
      message: "Inspection request session does not match active PairMesh session."
    });
  }

  let record = findInspectionThread(state, request.threadId);
  if (!record) {
    if (request.turnNumber !== 1) {
      return failureResponse(request, {
        code: "pairmesh.inspection_thread_not_found",
        message: "Inspection thread not found on receiving agent."
      });
    }

    const initiatorPeerId = options?.participantId;
    if (!initiatorPeerId) {
      return failureResponse(request, {
        code: "pairmesh.authentication_required",
        message: "Authenticated participant identity is required to start an inspection thread."
      });
    }

    const initiatorPeer = state.peers.find((peer) => peer.participant.id === initiatorPeerId);
    if (!initiatorPeer) {
      return failureResponse(request, {
        code: "pairmesh.peer_not_found",
        message: "Cannot resolve authenticated initiator peer for new inspection thread."
      });
    }

    record = {
      thread: {
        id: request.threadId,
        sessionId: request.sessionId,
        initiatorPeerId: initiatorPeer.participant.id,
        targetPeerId: state.localParticipant.participant.id,
        status: "active",
        createdAt: nowUtcIso(),
        updatedAt: nowUtcIso()
      },
      targetPeerName: initiatorPeer.agent.name,
      turns: []
    };
    state.inspectionThreads.push(record);
  } else if (record.thread.status === "closed") {
    return failureResponse(request, {
      code: "pairmesh.inspection_thread_closed",
      message: "Inspection thread is closed on receiving agent."
    });
  } else if (
    options?.participantId !== undefined &&
    record.thread.initiatorPeerId !== options.participantId
  ) {
    return failureResponse(request, {
      code: "pairmesh.permission_denied",
      message: "Inspection thread is not owned by the authenticated participant."
    });
  }

  const includeReferences =
    options?.participantId !== undefined
      ? mayIncludeSourceReferences(state, options.participantId)
      : false;

  const cached = findCachedTurnResult(record, request.requestId);
  if (cached) {
    return successResponse(
      request,
      cached.summary,
      cached.findings,
      includeReferences ? (cached.references ?? []) : []
    );
  }

  const initiatorPeerId = record.thread.initiatorPeerId;
  const initiatorPeer =
    state.peers.find((peer) => peer.participant.id === initiatorPeerId) ??
    (options?.participantId
      ? state.peers.find((peer) => peer.participant.id === options.participantId)
      : undefined);
  const requesterPeerName =
    initiatorPeer?.developer.displayName?.trim() || initiatorPeer?.agent.name?.trim() || "Peer";

  // Persist thread + running receiver execution before adapter work so watch can discover it.
  await stateStore.mutate((fresh) => {
    let threadRecord = findInspectionThread(fresh, request.threadId);
    if (!threadRecord) {
      threadRecord = {
        thread: record!.thread,
        targetPeerName: record!.targetPeerName,
        turns: []
      };
      fresh.inspectionThreads.push(threadRecord);
    }
    const now = nowUtcIso();
    const providerSnapshot = buildExecutionProviderSnapshot({
      providerId: adapter.provider.id,
      displayName: adapter.provider.displayName
    });
    upsertExecutionRecord(
      fresh,
      createReceiverInspectionExecution({
        requestId: request.requestId,
        threadId: request.threadId,
        requesterPeerId: initiatorPeerId,
        requesterPeerName,
        turnNumber: request.turnNumber,
        question: request.question,
        now,
        executionProviderId: providerSnapshot.executionProviderId,
        executionProviderDisplayName: providerSnapshot.executionProviderDisplayName
      })
    );
  });

  const priorTurns = buildSanitizedTurnContext(record.turns);
  const adapterRequest: CodingAgentRequest = {
    question: request.question,
    requestId: request.requestId,
    threadId: request.threadId,
    turnNumber: request.turnNumber,
    continuation: {
      providerSessionId: record.providerSessionId ?? record.cursorSessionId,
      cursorSessionId: record.cursorSessionId ?? record.providerSessionId,
      priorTurns
    }
  };

  const abortSignal = registerActiveInspection(request.requestId);
  let richActivitySeen = false;
  let progressSequence = 0;
  let persistChain: Promise<void> = Promise.resolve();

  const scheduleProgress = (event: ProgressEvent): void => {
    persistChain = persistChain
      .then(async () => {
        await stateStore.mutate((fresh) => {
          appendReceiverInspectionProgress(fresh, request.requestId, event, event.timestamp);
        });
        if (options?.onProgressPersisted) {
          const fresh = await stateStore.load();
          const execution = findExecutionRecord(fresh!, request.requestId);
          options.onProgressPersisted(execution?.progressEvents ?? []);
        }
      })
      .catch(() => {
        // Live persist must never fail the inspection worker.
      });
  };

  const inspectOptions: CodingAgentInspectOptions = {
    signal: abortSignal,
    onProviderActivity: (activity) => {
      richActivitySeen = true;
      scheduleProgress(
        mapProviderActivityToProgressEvent({
          actionId: request.requestId,
          event: activity,
          timestamp: nowUtcIso()
        })
      );
    },
    onProgress: (event) => {
      // Prefer rich provider activity when present; coarse phases remain the fallback.
      if (richActivitySeen) {
        return;
      }
      progressSequence += 1;
      scheduleProgress(
        mapInspectionProgressToProgressEvent({
          operationId: request.requestId,
          event,
          timestamp: nowUtcIso(),
          sequence: progressSequence,
          providerEventId: `inspect:${request.requestId}:phase:${event.phase}:${progressSequence}`
        })
      );
    }
  };

  try {
    const invoked = await invokeCodingAgent(request, adapter, adapterRequest, inspectOptions);
    await persistChain;

    if (!invoked.response.accepted) {
      const failure = invoked.response;
      await stateStore.mutate((fresh) => {
        const execution = findExecutionRecord(fresh, request.requestId);
        if (!execution || execution.ownerRole !== "receiver") {
          return;
        }
        const now = nowUtcIso();
        upsertExecutionRecord(
          fresh,
          InspectionExecutionRecordSchema.parse({
            ...execution,
            status: "failed",
            phase: "failed",
            updatedAt: now,
            completedAt: now,
            error: {
              code: failure.error.code,
              message: failure.error.message
            }
          })
        );
      });
      return failure;
    }

    const success = invoked.response;
    const references = includeReferences ? (success.references ?? []) : [];

    await stateStore.mutate((fresh) => {
      const threadRecord = findInspectionThread(fresh, request.threadId);
      if (!threadRecord) {
        return;
      }
      threadRecord.turns.push({
        turn: buildTurnFromRequest(request),
        result: buildTurnResult(request, success.summary, success.findings, references)
      });
      if (invoked.providerSessionId) {
        threadRecord.providerSessionId = invoked.providerSessionId;
        threadRecord.cursorSessionId = invoked.providerSessionId;
      }
      threadRecord.thread = { ...threadRecord.thread, updatedAt: nowUtcIso() };

      const execution = findExecutionRecord(fresh, request.requestId);
      if (execution && execution.ownerRole === "receiver") {
        const now = nowUtcIso();
        upsertExecutionRecord(
          fresh,
          InspectionExecutionRecordSchema.parse({
            ...execution,
            status: "completed",
            phase: "completed",
            message: "Inspection completed.",
            updatedAt: now,
            completedAt: now,
            result: {
              summary: success.summary,
              findings: success.findings,
              ...(references.length ? { references } : {})
            }
          })
        );
      }
    });

    return successResponse(request, success.summary, success.findings, references);
  } finally {
    clearActiveInspection(request.requestId);
  }
}

async function invokeCodingAgent(
  request: PairMeshInspectionRequest,
  adapter: CodingAgentAdapter,
  adapterRequest: CodingAgentRequest,
  inspectOptions?: CodingAgentInspectOptions
): Promise<{
  response: PairMeshInspectionResponse;
  providerSessionId?: string;
}> {
  try {
    const availability = await adapter.getAvailability();
    if (availability.status === "busy") {
      return {
        response: failureResponse(
          request,
          createPairMeshError({
            code: "pairmesh.coding_agent_unavailable",
            message: "Local coding agent is busy with another inspection.",
            details: availability.reason ? { reason: availability.reason } : undefined
          })
        )
      };
    }

    if (availability.status === "unavailable") {
      return {
        response: failureResponse(
          request,
          createPairMeshError({
            code: "pairmesh.coding_agent_unavailable",
            message: availability.reason ?? "Local coding agent is unavailable.",
            details: { provider: availability.provider }
          })
        )
      };
    }

    const result = await adapter.inspect(adapterRequest, inspectOptions);
    return {
      response: successResponse(request, result.summary, result.findings, result.references ?? []),
      providerSessionId: result.providerSessionId ?? result.cursorSessionId
    };
  } catch (error) {
    if (isCodingAgentError(error)) {
      return { response: failureResponse(request, mapCodingAgentError(error)) };
    }

    return {
      response: failureResponse(request, {
        code: "pairmesh.internal_error",
        message: "Inspection failed due to an unexpected local error."
      })
    };
  }
}

function buildAdapterRequest(request: PairMeshInspectionRequest): CodingAgentRequest {
  return {
    question: request.question,
    requestId: request.requestId,
    threadId: request.threadId,
    turnNumber: request.turnNumber
  };
}

function successResponse(
  request: PairMeshInspectionRequest,
  summary: string,
  findings: string[],
  references: PairMeshSourceReference[] = []
): PairMeshInspectionResponse {
  return PairMeshInspectionSuccessResponseSchema.parse({
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: true,
    requestId: request.requestId,
    summary,
    findings,
    references
  });
}

function failureResponse(
  request: PairMeshInspectionRequest,
  error: ReturnType<typeof createPairMeshError>
): PairMeshInspectionResponse {
  return PairMeshInspectionFailureResponseSchema.parse({
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: false,
    requestId: request.requestId,
    error
  });
}

function mapCodingAgentError(error: ReturnType<typeof createCodingAgentError>) {
  switch (error.code) {
    case "agent_unavailable":
    case "agent_not_authenticated":
    case "agent_misconfigured":
    case "agent_busy":
      return createPairMeshError({
        code: "pairmesh.coding_agent_unavailable",
        message: error.message
      });
    case "agent_timeout": {
      const timeoutMs =
        typeof error.details?.timeoutMs === "number" ? error.details.timeoutMs : undefined;
      return createPairMeshError({
        code: "pairmesh.inspection_timeout",
        message: "Inspection timed out while the coding agent was running.",
        ...(timeoutMs !== undefined ? { details: { timeoutMs } } : {})
      });
    }
    case "agent_cancelled":
      return createPairMeshError({
        code: "pairmesh.inspection_cancelled",
        message: "Inspection was cancelled."
      });
    case "agent_permission_denied":
      return createPairMeshError({
        code: "pairmesh.permission_denied",
        message: "Inspection permission was denied by the local coding agent."
      });
    case "agent_execution_failed":
    default:
      return createPairMeshError({
        code: "pairmesh.internal_error",
        message: error.message
      });
  }
}

export {
  appendInitiatorTurn,
  buildTurnResult,
  requireInitiatorThread,
  createInitiatorThreadRecord,
  listInspectionThreads,
  closeThreadRecord,
  findCachedTurnResult
};

export type { LocalSessionState };
