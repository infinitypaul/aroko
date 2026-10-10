import {
  createPairMeshError,
  PAIRMESH_METADATA_VERSION,
  type InspectionExecutionRecord,
  type InspectionExecutionResult,
  type InspectionRemoteTaskState,
  type PairMeshInspectionResponse,
  type PairMeshSourceReference
} from "@pairmesh/protocol";
import {
  cancelPairMeshInspectionTask,
  getPairMeshInspectionTask,
  resendInspectionForCachedResult
} from "../a2a/inspection-client.js";
import {
  extractInspectProgressFromTask,
  mapRemoteTaskStateToExecutionStatus,
  normalizeA2ATaskState
} from "../a2a/task-lifecycle.js";
import type { LocalSessionState } from "../session/schemas.js";
import {
  cacheExecutionResult,
  completeExecutionRecord,
  findExecutionRecord,
  inspectionExecutionDeadlineStartMs,
  replaceInitiatorProgressEvents,
  updateExecutionProgress,
  updateExecutionRemoteTask
} from "./execution-store.js";
import { mergeRequesterInspectProgress } from "./requester-progress.js";
import { appendInitiatorTurn, buildTurnResult, requireInitiatorThread } from "./thread-store.js";
import type { PairMeshInspectionRequest } from "@pairmesh/protocol";
import type { LocalStateStore } from "../state/store.js";

export interface RemoteSyncOptions {
  maxDurationMs: number;
  signal?: AbortSignal;
  attemptCancelOnHardTimeout?: boolean;
  /** One bounded getTask sync — no resend recovery loop (for pairmesh_inspection_status). */
  quickSync?: boolean;
}

export interface RemoteSyncOutcome {
  record: InspectionExecutionRecord;
  response?: PairMeshInspectionResponse;
  hardTimedOut: boolean;
}

export async function syncExecutionFromRemoteTask(
  requestId: string,
  stateStore: LocalStateStore,
  options: RemoteSyncOptions
): Promise<RemoteSyncOutcome> {
  const early = await stateStore.enqueue(async () => {
    const state = await loadActiveSession(stateStore);
    const record = findExecutionRecord(state, requestId);
    if (!record) {
      throw createPairMeshError({
        code: "pairmesh.inspection_not_found",
        message: "No inspection execution found for the given request id.",
        details: { requestId }
      });
    }

    if (record.status === "completed" && record.result) {
      return { kind: "done" as const, record, hardTimedOut: false };
    }

    // Local failed/cancelled are authoritative. Local timed_out may be fabricated while
    // remote already COMPLETED — allow recovery poll when a remote task id remains.
    if (record.status === "failed" || record.status === "cancelled") {
      return { kind: "done" as const, record, hardTimedOut: false };
    }

    const a2aTaskId = record.a2aTaskReference?.a2aTaskId;
    const peerUrl = resolveCurrentPeerPollUrl(state, record);
    const pastHardDeadline = isPastHardDeadline(record, options.maxDurationMs);

    // No remote task identity: cannot reattach. Hard-timeout locally if past deadline.
    if (!peerUrl || !a2aTaskId) {
      if (pastHardDeadline && (record.status === "running" || record.status === "pending")) {
        completeExecutionRecord(state, requestId, "timed_out", {
          code: "pairmesh.inspection_timeout",
          message: "Remote inspection exceeded the configured execution deadline."
        });
        await stateStore.writeExclusive(state);
        return {
          kind: "done" as const,
          record: findExecutionRecord(state, requestId)!,
          hardTimedOut: true
        };
      }
      return {
        kind: "done" as const,
        record,
        hardTimedOut: record.status === "timed_out"
      };
    }

    if (
      record.peerAgentUrl !== peerUrl ||
      record.a2aTaskReference?.agent?.a2aAgentCardUrl !== peerUrl
    ) {
      refreshExecutionPeerUrl(state, requestId, peerUrl);
      await stateStore.writeExclusive(state);
    }

    return {
      kind: "poll" as const,
      peerUrl,
      a2aTaskId,
      bearerToken: resolvePeerBearer(state, record.peerId),
      localWaitState: record.localWaitState,
      question: record.question,
      threadId: record.threadId,
      turnNumber: record.turnNumber,
      sessionId: state.session.id,
      pastHardDeadline,
      recoveringLocalTimeout: record.status === "timed_out"
    };
  });

  if (early.kind === "done") {
    return { record: early.record, hardTimedOut: early.hardTimedOut };
  }

  // Transport failure must NOT fabricate local timed_out — wait loop surfaces
  // peer_transport_unavailable and retries after route remint.
  const polled = await getPairMeshInspectionTask(early.peerUrl, early.a2aTaskId, {
    signal: options.signal,
    bearerToken: early.bearerToken
  });
  const remoteTaskState = normalizeA2ATaskState(polled.task.status?.state);
  const wireProgress = extractInspectProgressFromTask(polled.task);

  await commitActiveSession(stateStore, (state) => {
    reviveFabricatedLocalTimeout(state, requestId);
    updateExecutionRemoteTask(state, requestId, remoteTaskState);
    if (wireProgress?.events?.length) {
      const current = findExecutionRecord(state, requestId);
      const merged = mergeRequesterInspectProgress(current?.progressEvents, wireProgress.events);
      replaceInitiatorProgressEvents(state, requestId, merged);
    }
  });

  if (polled.response?.accepted) {
    return await applySuccessfulRemoteResponse(requestId, polled.response, stateStore);
  }

  if (
    !options.quickSync &&
    !polled.response &&
    early.localWaitState === "expired" &&
    (polled.taskEvicted || remoteTaskState === "completed")
  ) {
    const recovered = await resendInspectionForCachedResult(
      early.peerUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: early.sessionId,
        threadId: early.threadId,
        requestId,
        question: early.question,
        turnNumber: early.turnNumber
      },
      { timeoutMs: Math.min(5_000, options.maxDurationMs), bearerToken: early.bearerToken }
    );
    if (recovered?.accepted) {
      return await applySuccessfulRemoteResponse(requestId, recovered, stateStore);
    }
  }

  if (polled.response && !polled.response.accepted) {
    const error = polled.response.error;
    if (!error || typeof error.code !== "string") {
      await commitActiveSession(stateStore, (state) => {
        completeExecutionRecord(state, requestId, "failed", {
          code: "pairmesh.internal_error",
          message: "Remote inspection returned an unsuccessful response without error detail."
        });
      });
      const record = await stateStore.enqueue(async () => {
        const state = await loadActiveSession(stateStore);
        return findExecutionRecord(state, requestId)!;
      });
      return {
        record,
        response: polled.response,
        hardTimedOut: false
      };
    }
    const status =
      error.code === "pairmesh.inspection_timeout"
        ? "timed_out"
        : error.code === "pairmesh.inspection_cancelled"
          ? "cancelled"
          : "failed";
    await commitActiveSession(stateStore, (state) => {
      completeExecutionRecord(state, requestId, status, {
        code: error.code,
        message: error.message
      });
    });
    const record = await stateStore.enqueue(async () => {
      const state = await loadActiveSession(stateStore);
      return findExecutionRecord(state, requestId)!;
    });
    return {
      record,
      response: polled.response,
      hardTimedOut: status === "timed_out"
    };
  }

  const mappedStatus = mapRemoteTaskStateToExecutionStatus(remoteTaskState);
  if (mappedStatus !== "running") {
    await commitActiveSession(stateStore, (state) => {
      completeExecutionRecord(state, requestId, mappedStatus, {
        code:
          mappedStatus === "cancelled"
            ? "pairmesh.inspection_cancelled"
            : mappedStatus === "timed_out"
              ? "pairmesh.inspection_timeout"
              : "pairmesh.internal_error",
        message: `Remote A2A task reached terminal state: ${remoteTaskState}.`
      });
    });
    const record = await stateStore.enqueue(async () => {
      const state = await loadActiveSession(stateStore);
      return findExecutionRecord(state, requestId)!;
    });
    return {
      record,
      hardTimedOut: mappedStatus === "timed_out"
    };
  }

  // Hard deadline only after successful remote contact that still shows running.
  if (early.pastHardDeadline) {
    if (options.attemptCancelOnHardTimeout !== false) {
      try {
        await cancelPairMeshInspectionTask(early.peerUrl, early.a2aTaskId, early.bearerToken);
      } catch {
        /* best-effort */
      }
    }
    await commitActiveSession(stateStore, (state) => {
      completeExecutionRecord(state, requestId, "timed_out", {
        code: "pairmesh.inspection_timeout",
        message: "Remote inspection exceeded the configured execution deadline."
      });
    });
    const record = await stateStore.enqueue(async () => {
      const state = await loadActiveSession(stateStore);
      return findExecutionRecord(state, requestId)!;
    });
    return { record, hardTimedOut: true };
  }

  const record = await stateStore.enqueue(async () => {
    const state = await loadActiveSession(stateStore);
    return findExecutionRecord(state, requestId)!;
  });

  return {
    record,
    hardTimedOut: false
  };
}

export function resolveCurrentPeerPollUrl(
  state: LocalSessionState,
  record: InspectionExecutionRecord
): string | undefined {
  const live = state.peers.find((peer) => peer.participant.id === record.peerId)?.a2aAgentUrl;
  if (typeof live === "string" && live.trim()) {
    return live.trim().replace(/\/$/, "");
  }
  const snapshotted = record.peerAgentUrl ?? record.a2aTaskReference?.agent?.a2aAgentCardUrl;
  return typeof snapshotted === "string" && snapshotted.trim()
    ? snapshotted.trim().replace(/\/$/, "")
    : undefined;
}

function isPastHardDeadline(record: InspectionExecutionRecord, maxDurationMs: number): boolean {
  const deadlineStartMs = inspectionExecutionDeadlineStartMs(record);
  if (deadlineStartMs === undefined) {
    return false;
  }
  return Date.now() - deadlineStartMs > maxDurationMs;
}

function refreshExecutionPeerUrl(
  state: LocalSessionState,
  requestId: string,
  peerUrl: string
): void {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return;
  }
  const idx = state.inspectionExecutions.findIndex((e) => e.requestId === requestId);
  if (idx < 0) {
    return;
  }
  state.inspectionExecutions[idx] = {
    ...record,
    peerAgentUrl: peerUrl,
    a2aTaskReference: record.a2aTaskReference
      ? {
          ...record.a2aTaskReference,
          agent: { a2aAgentCardUrl: peerUrl }
        }
      : record.a2aTaskReference,
    updatedAt: new Date().toISOString()
  };
}

/** Clear a fabricated local timed_out so remote COMPLETED can become authoritative. */
function reviveFabricatedLocalTimeout(state: LocalSessionState, requestId: string): void {
  const existing = findExecutionRecord(state, requestId);
  if (!existing || existing.status !== "timed_out" || existing.result) {
    return;
  }
  const idx = state.inspectionExecutions.findIndex((e) => e.requestId === requestId);
  if (idx < 0) {
    return;
  }
  const rest = { ...existing };
  delete rest.error;
  delete rest.completedAt;
  state.inspectionExecutions[idx] = {
    ...rest,
    status: "running",
    phase: "inspecting",
    updatedAt: new Date().toISOString()
  };
}

/** Bearer this agent presents to the peer that owns the remote inspection task. */
function resolvePeerBearer(state: LocalSessionState, peerId: string): string | undefined {
  return state.peers.find((peer) => peer.participant.id === peerId)?.outboundBearer;
}

export async function applySuccessfulRemoteResponse(
  requestId: string,
  response: PairMeshInspectionResponse,
  stateStore: LocalStateStore
): Promise<RemoteSyncOutcome> {
  if (!response.accepted) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "Cannot apply a failed inspection response as success."
    });
  }

  await commitActiveSession(stateStore, (state) => {
    const existing = findExecutionRecord(state, requestId);
    if (!existing) {
      throw createPairMeshError({
        code: "pairmesh.inspection_not_found",
        message: "No inspection execution found for the given request id.",
        details: { requestId }
      });
    }

    const threadRecord = requireInitiatorThread(state, existing.threadId);
    const request: PairMeshInspectionRequest = {
      metadataVersion: response.metadataVersion,
      sessionId: state.session.id,
      threadId: existing.threadId,
      requestId: existing.requestId,
      question: existing.question,
      turnNumber: existing.turnNumber
    };

    if (!threadRecord.turns.some((turn) => turn.turn.requestId === requestId)) {
      appendInitiatorTurn(
        threadRecord,
        request,
        buildTurnResult(request, response.summary, response.findings, response.references ?? [])
      );
    }

    const result: InspectionExecutionResult = {
      summary: response.summary,
      findings: response.findings,
      references: response.references ?? []
    };
    cacheExecutionResult(state, requestId, result, "completed");
    updateExecutionProgress(state, requestId, {
      phase: "completed",
      message: "Inspection completed."
    });
  });

  const finalized = await stateStore.enqueue(async () => {
    const state = await loadActiveSession(stateStore);
    return findExecutionRecord(state, requestId)!;
  });

  return {
    record: finalized,
    response,
    hardTimedOut: false
  };
}

async function loadActiveSession(stateStore: LocalStateStore): Promise<LocalSessionState> {
  const state = await stateStore.load();
  if (!state) {
    throw createPairMeshError({
      code: "pairmesh.session_not_found",
      message: "No local PairMesh session found."
    });
  }
  if (state.session.status === "closed") {
    throw createPairMeshError({
      code: "pairmesh.session_closed",
      message: "The local PairMesh session is closed.",
      details: { sessionCode: state.sessionCode }
    });
  }
  return state;
}

async function commitActiveSession(
  stateStore: LocalStateStore,
  apply: (state: LocalSessionState) => void | Promise<void>
): Promise<LocalSessionState> {
  let committed!: LocalSessionState;
  await stateStore.mutate(async (state) => {
    if (state.session.status === "closed") {
      throw createPairMeshError({
        code: "pairmesh.session_closed",
        message: "The local PairMesh session is closed.",
        details: { sessionCode: state.sessionCode }
      });
    }
    await apply(state);
    committed = state;
  });
  return committed;
}

export function toInspectionResultView(record: InspectionExecutionRecord):
  | {
      summary: string;
      findings: string[];
      references: PairMeshSourceReference[];
    }
  | undefined {
  if (!record.result) {
    return undefined;
  }
  return {
    summary: record.result.summary,
    findings: record.result.findings,
    references: record.result.references ?? []
  };
}

export function buildInspectionStatusView(
  record: InspectionExecutionRecord,
  options?: {
    /** Optional safe peer metadata — does not replace string `peer` (name). */
    safePeer?: {
      participantId: string;
      displayName: string;
      service?: string;
    };
  }
): Record<string, unknown> {
  const elapsedMs = Date.now() - Date.parse(record.startedAt);
  const executionElapsedMs = record.executionStartedAt
    ? Date.now() - Date.parse(record.executionStartedAt)
    : undefined;
  const view: Record<string, unknown> = {
    requestId: record.requestId,
    threadId: record.threadId,
    peer: record.peerName,
    ...(options?.safePeer ? { safePeer: options.safePeer } : {}),
    status: record.status === "running" ? "working" : record.status,
    startedAt: record.startedAt,
    ...(record.executionStartedAt ? { executionStartedAt: record.executionStartedAt } : {}),
    elapsedMs,
    ...(executionElapsedMs !== undefined ? { executionElapsedMs } : {}),
    ...(record.message ? { message: record.message } : {}),
    ...(record.localWaitState ? { localWait: record.localWaitState } : {})
  };

  if (record.a2aTaskReference || record.remoteTaskState) {
    view.remoteTask = {
      ...(record.a2aTaskReference?.a2aTaskId ? { id: record.a2aTaskReference.a2aTaskId } : {}),
      ...(record.remoteTaskState ? { state: record.remoteTaskState } : {})
    };
  }

  if (record.progressEvents?.length) {
    view.progressEvents = record.progressEvents;
  }

  if (record.status === "completed" && record.result) {
    view.result = record.result;
  }

  if (record.error) {
    view.error = record.error;
  }

  return view;
}

export type { InspectionRemoteTaskState };
