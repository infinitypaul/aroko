import {
  InspectionThreadIdSchema,
  InspectionTurnIdSchema,
  IsoUtcTimestampSchema,
  PAIRMESH_METADATA_VERSION,
  PairMeshInspectionThreadSchema,
  PairMeshInspectionTurnSchema,
  createPairMeshError,
  type InspectionThreadId,
  type PairMeshInspectionRequest,
  type PairMeshInspectionTurn,
  type PairMeshInspectionTurnResult
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import type {
  LocalInspectionThreadRecord,
  LocalInspectionTurnRecord,
  LocalSessionState
} from "../session/schemas.js";

export const MAX_PRIOR_TURNS_FOR_CONTEXT = 5;
export const MAX_CONTEXT_CHAR_BUDGET = 8000;

export function createInspectionThreadId(): InspectionThreadId {
  return InspectionThreadIdSchema.parse(`thr_${randomUUID()}`);
}

export function createInspectionTurnId(): string {
  return InspectionTurnIdSchema.parse(`trn_${randomUUID()}`);
}

export function findInspectionThread(
  state: LocalSessionState,
  threadId: InspectionThreadId
): LocalInspectionThreadRecord | undefined {
  return state.inspectionThreads.find((record) => record.thread.id === threadId);
}

export function listInspectionThreads(
  state: LocalSessionState,
  peerFilter?: string
): LocalInspectionThreadRecord[] {
  const normalizedPeer = peerFilter?.trim();
  if (!normalizedPeer) {
    return state.inspectionThreads;
  }
  return state.inspectionThreads.filter((record) => record.targetPeerName === normalizedPeer);
}

export function requireInitiatorThread(
  state: LocalSessionState,
  threadId: InspectionThreadId
): LocalInspectionThreadRecord {
  const record = findInspectionThread(state, threadId);
  if (!record) {
    throw createPairMeshError({
      code: "pairmesh.inspection_thread_not_found",
      message: "Inspection thread not found in the active PairMesh session.",
      details: { threadId }
    });
  }

  if (record.thread.sessionId !== state.session.id) {
    throw createPairMeshError({
      code: "pairmesh.inspection_thread_invalid_state",
      message: "Inspection thread does not belong to the active PairMesh session.",
      details: { threadId, sessionId: state.session.id }
    });
  }

  if (record.thread.status === "closed") {
    throw createPairMeshError({
      code: "pairmesh.inspection_thread_closed",
      message: "Inspection thread is closed.",
      details: { threadId }
    });
  }

  return record;
}

export function createInitiatorThreadRecord(options: {
  state: LocalSessionState;
  targetPeerName: string;
  targetPeerId: string;
  topic?: string;
}): LocalInspectionThreadRecord {
  const now = nowUtc();
  const thread = PairMeshInspectionThreadSchema.parse({
    id: createInspectionThreadId(),
    sessionId: options.state.session.id,
    initiatorPeerId: options.state.localParticipant.participant.id,
    targetPeerId: options.targetPeerId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...(options.topic ? { topic: options.topic } : {})
  });

  return {
    thread,
    targetPeerName: options.targetPeerName,
    turns: []
  };
}

export function appendInitiatorTurn(
  record: LocalInspectionThreadRecord,
  request: PairMeshInspectionRequest,
  result: PairMeshInspectionTurnResult
): LocalInspectionTurnRecord {
  const turnRecord: LocalInspectionTurnRecord = {
    turn: buildTurnFromRequest(request),
    result
  };
  record.turns.push(turnRecord);
  record.thread = {
    ...record.thread,
    updatedAt: nowUtc()
  };
  return turnRecord;
}

export function buildTurnFromRequest(request: PairMeshInspectionRequest): PairMeshInspectionTurn {
  return PairMeshInspectionTurnSchema.parse({
    id: createInspectionTurnId(),
    threadId: request.threadId,
    requestId: request.requestId,
    question: request.question,
    createdAt: nowUtc()
  });
}

export function findCachedTurnResult(
  record: LocalInspectionThreadRecord,
  requestId: string
): PairMeshInspectionTurnResult | undefined {
  return record.turns.find((turn) => turn.turn.requestId === requestId)?.result;
}

export function buildSanitizedTurnContext(
  turns: LocalInspectionTurnRecord[],
  maxTurns = MAX_PRIOR_TURNS_FOR_CONTEXT,
  maxChars = MAX_CONTEXT_CHAR_BUDGET
): Array<{
  question: string;
  summary: string;
  findings: string[];
  references: import("@pairmesh/protocol").PairMeshSourceReference[];
}> {
  const completed = turns.filter((turn) => turn.result !== undefined);
  const recent = completed.slice(-maxTurns);
  const context: Array<{
    question: string;
    summary: string;
    findings: string[];
    references: import("@pairmesh/protocol").PairMeshSourceReference[];
  }> = [];
  let usedChars = 0;

  for (const turn of recent) {
    const result = turn.result!;
    const entry = {
      question: turn.turn.question,
      summary: result.summary,
      findings: result.findings,
      references: result.references ?? []
    };
    const entrySize = JSON.stringify(entry).length;
    if (usedChars + entrySize > maxChars) {
      break;
    }
    context.push(entry);
    usedChars += entrySize;
  }

  return context;
}

export function closeThreadRecord(record: LocalInspectionThreadRecord): void {
  record.thread = {
    ...record.thread,
    status: "closed",
    updatedAt: nowUtc()
  };
}

function nowUtc(): string {
  return IsoUtcTimestampSchema.parse(new Date().toISOString());
}

export function nowUtcIso(): string {
  return nowUtc();
}

export function buildTurnResult(
  request: PairMeshInspectionRequest,
  summary: string,
  findings: string[],
  references: import("@pairmesh/protocol").PairMeshSourceReference[] = []
): PairMeshInspectionTurnResult {
  return {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    requestId: request.requestId,
    summary,
    findings,
    references
  };
}
