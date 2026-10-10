import {
  appendProgressEvent,
  filterProgressEventsForViewer,
  InspectionExecutionRecordSchema,
  latestProgressEvent,
  type InspectionExecutionRecord,
  type ProgressEvent
} from "@pairmesh/protocol";
import type { LocalSessionState } from "../session/schemas.js";
import { toSafePeerMeta, type SafePeerMeta } from "./peer-view.js";
import { upsertExecutionRecord } from "../inspect/execution-store.js";
import { resolveStoredProviderDisplayName } from "../execution/provider-snapshot.js";

export type ReceiverInspectionListFilter = "active" | "recent" | "all";

export interface InspectionSafeView {
  kind: "inspection";
  requestId: string;
  status: InspectionExecutionRecord["status"];
  question: string;
  peer?: SafePeerMeta;
  summary?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  terminal: boolean;
  progress: ProgressEvent[];
  latestProgress?: ProgressEvent;
  providerDisplayName?: string;
  executionProviderId?: string;
}

const IN_FLIGHT: ReadonlySet<InspectionExecutionRecord["status"]> = new Set(["pending", "running"]);

export function isTerminalInspectionStatus(status: InspectionExecutionRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

export function listReceiverInspectionViews(
  state: LocalSessionState,
  filter: ReceiverInspectionListFilter,
  limit = 50
): InspectionSafeView[] {
  const executions = (state.inspectionExecutions ?? []).filter(
    (entry) => entry.ownerRole === "receiver"
  );

  let filtered: InspectionExecutionRecord[];
  switch (filter) {
    case "active":
      filtered = executions.filter((entry) => IN_FLIGHT.has(entry.status));
      break;
    case "recent":
      filtered = executions
        .filter((entry) => isTerminalInspectionStatus(entry.status))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 200));
      break;
    case "all":
      filtered = executions
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 200));
      break;
  }

  if (filter === "active") {
    filtered = [...filtered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  return filtered.map((execution) => toInspectionSafeView(state, execution));
}

export function toInspectionSafeView(
  state: LocalSessionState,
  execution: InspectionExecutionRecord
): InspectionSafeView {
  const peerRecord = state.peers.find((entry) => entry.participant.id === execution.peerId);
  const progress = filterProgressEventsForViewer(execution.progressEvents, "owner");
  const latest = latestProgressEvent(progress);
  const providerDisplayName = resolveStoredProviderDisplayName(execution);
  const peerFallback: SafePeerMeta | undefined = peerRecord
    ? toSafePeerMeta(peerRecord)
    : {
        participantId: execution.peerId,
        displayName: execution.peerName
      };
  return {
    kind: "inspection",
    requestId: execution.requestId,
    status: execution.status,
    question: execution.question,
    ...(peerFallback ? { peer: peerFallback } : {}),
    ...(execution.result?.summary ? { summary: execution.result.summary } : {}),
    ...(execution.message ? { message: execution.message } : {}),
    createdAt: execution.startedAt,
    updatedAt: execution.updatedAt,
    ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
    terminal: isTerminalInspectionStatus(execution.status),
    progress,
    ...(latest ? { latestProgress: latest } : {}),
    ...(providerDisplayName ? { providerDisplayName } : {}),
    ...(execution.executionProviderId ? { executionProviderId: execution.executionProviderId } : {})
  };
}

export function createReceiverInspectionExecution(input: {
  requestId: string;
  threadId: string;
  requesterPeerId: string;
  requesterPeerName: string;
  turnNumber: number;
  question: string;
  now: string;
  seedProgress?: ProgressEvent[];
  executionProviderId?: string;
  executionProviderDisplayName?: string;
}): InspectionExecutionRecord {
  return InspectionExecutionRecordSchema.parse({
    requestId: input.requestId,
    threadId: input.threadId,
    peerId: input.requesterPeerId,
    peerName: input.requesterPeerName,
    turnNumber: input.turnNumber,
    question: input.question,
    status: "running",
    phase: "coding-agent-starting",
    message: "Starting local inspection.",
    startedAt: input.now,
    executionStartedAt: input.now,
    updatedAt: input.now,
    ownerRole: "receiver",
    ...(input.seedProgress?.length ? { progressEvents: input.seedProgress } : {}),
    ...(input.executionProviderId ? { executionProviderId: input.executionProviderId } : {}),
    ...(input.executionProviderDisplayName
      ? { executionProviderDisplayName: input.executionProviderDisplayName }
      : {})
  });
}

export function appendReceiverInspectionProgress(
  state: LocalSessionState,
  requestId: string,
  event: ProgressEvent,
  now: string
): InspectionExecutionRecord | undefined {
  const record = state.inspectionExecutions.find((entry) => entry.requestId === requestId);
  if (!record || record.ownerRole !== "receiver") {
    return undefined;
  }
    if (isTerminalInspectionStatus(record.status)) {
    return record;
  }
  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    status: record.status === "pending" ? "running" : record.status,
    updatedAt: now,
    progressEvents: appendProgressEvent(record.progressEvents, event)
  });
  upsertExecutionRecord(state, updated);
  return updated;
}
