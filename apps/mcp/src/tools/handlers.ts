import type {
  ActionSafeView,
  CollaborateAskResult,
  InspectionThreadDetail,
  InspectionThreadSummary,
  PeerHealthResult,
  SafePeerView,
  SessionManager,
  SessionStatusView,
  WaitForInspectionResult
} from "@pairmesh/client";
import {
  PAIRMESH_BUILD_ID,
  PAIRMESH_BUILD_TIMESTAMP,
  PAIRMESH_VERSION,
  collaborateAsk
} from "@pairmesh/client";
import {
  ActionIdSchema,
  ArtifactIdSchema,
  InspectionThreadIdSchema,
  createPairMeshError,
  type PairMeshActionWireSuccessResponse
} from "@pairmesh/protocol";

const FORBIDDEN_TESTS_RUN_KEYS = ["executable", "args", "cwd", "env"] as const;

const APPROVAL_REQUIRED_MESSAGE =
  "Peer must approve this action locally before it can continue. Do not re-pair or run PairMesh setup. There is no MCP approve tool — wait for the peer human, then use pairmesh_action_status or pairmesh_wait_for_action with the same actionId.";

const DEFAULT_ACTION_WAIT_MS = 8_000;

export interface PairMeshStatusResult {
  connected: boolean;
  pairmeshVersion?: string;
  pairmeshBuildId?: string;
  pairmeshBuildTimestamp?: string;
  session?: {
    code: string;
    id: string;
    status: "active" | "closed";
  };
  localAgent?: {
    name: string;
    agentId: string;
  };
  peerCount?: number;
}

export async function getPairMeshStatus(
  sessionManager: SessionManager
): Promise<PairMeshStatusResult> {
  try {
    const status = await sessionManager.getSessionStatus();
    return toStatusResult(status);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "pairmesh.session_not_found"
    ) {
      return {
        connected: false,
        pairmeshVersion: PAIRMESH_VERSION,
        pairmeshBuildId: PAIRMESH_BUILD_ID,
        pairmeshBuildTimestamp: PAIRMESH_BUILD_TIMESTAMP
      };
    }
    throw error;
  }
}

export function toStatusResult(status: SessionStatusView): PairMeshStatusResult {
  return {
    connected: true,
    pairmeshVersion: PAIRMESH_VERSION,
    pairmeshBuildId: PAIRMESH_BUILD_ID,
    pairmeshBuildTimestamp: PAIRMESH_BUILD_TIMESTAMP,
    session: {
      code: status.sessionCode,
      id: status.sessionId,
      status: status.status
    },
    localAgent: {
      name: status.localParticipant.agent.name,
      agentId: status.localParticipant.agent.id
    },
    peerCount: status.peers.length
  };
}

/** Safe peer row — SafePeerView-shaped with backward-compat aliases. */
export interface PairMeshPeerSummary {
  /** @deprecated Prefer participantId — kept for backward compatibility. */
  id: string;
  participantId: string;
  displayName: string;
  /** @deprecated Prefer agentName / displayName. */
  name: string;
  agentName: string;
  agentId: string;
  service?: string;
  relationship: SafePeerView["relationship"];
  connectivity: SafePeerView["connectivity"];
}

export interface PairMeshListPeersResult {
  peers: PairMeshPeerSummary[];
}

export async function listPairMeshPeers(
  sessionManager: SessionManager
): Promise<PairMeshListPeersResult> {
  const [safePeers, status] = await Promise.all([
    sessionManager.listSafePeers(),
    sessionManager.getSessionStatus()
  ]);
  const agentIdByParticipant = new Map<string, string>(
    status.peers.map((peer) => [peer.participant.id, peer.agent.id])
  );
  return {
    peers: safePeers.map((peer) => ({
      id: peer.participantId,
      participantId: peer.participantId,
      displayName: peer.displayName,
      name: peer.agentName,
      agentName: peer.agentName,
      agentId: agentIdByParticipant.get(peer.participantId) ?? peer.participantId,
      ...(peer.service ? { service: peer.service } : {}),
      relationship: peer.relationship,
      connectivity: peer.connectivity
    }))
  };
}

export interface PairMeshSendResult {
  peer: string;
  request: string;
  response: string;
}

export async function sendPairMeshMessage(
  sessionManager: SessionManager,
  peer: string,
  message: string
): Promise<PairMeshSendResult> {
  const trimmedPeer = peer.trim();
  const trimmedMessage = message.trim();
  if (!trimmedPeer || !trimmedMessage) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer and message are required.",
      details: { field: trimmedPeer ? "message" : "peer" }
    });
  }

  const result = await sessionManager.sendToPeer(trimmedPeer, trimmedMessage);
  return {
    peer: trimmedPeer,
    request: result.requestText,
    response: result.responseText
  };
}

export interface PairMeshAskPeerResult {
  completed: boolean;
  status?: "working" | "approval_required";
  threadId: string;
  requestId: string;
  peer: string;
  safePeer?: {
    participantId: string;
    displayName: string;
    service?: string;
  };
  question: string;
  summary?: string;
  findings?: string[];
  references?: import("@pairmesh/protocol").PairMeshSourceReference[];
  message?: string;
  permissionRequestId?: string;
  capability?: string;
}

export async function askPairMeshPeer(
  sessionManager: SessionManager,
  peer: string,
  question: string
): Promise<PairMeshAskPeerResult> {
  const trimmedPeer = peer.trim();
  const trimmedQuestion = question.trim();
  if (!trimmedPeer || !trimmedQuestion) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer and question are required.",
      details: { field: trimmedPeer ? "question" : "peer" }
    });
  }

  const result = await sessionManager.askPeer(trimmedPeer, trimmedQuestion);
  if (!result.completed) {
    if (result.status === "approval_required") {
      return {
        completed: false,
        status: "approval_required",
        threadId: result.threadId,
        requestId: result.requestId,
        peer: result.peer,
        ...(result.safePeer ? { safePeer: result.safePeer } : {}),
        question: result.question,
        permissionRequestId: result.permissionRequestId,
        capability: result.capability,
        message: result.message
      };
    }
    return {
      completed: false,
      status: "working",
      threadId: result.threadId,
      requestId: result.requestId,
      peer: result.peer,
      ...(result.safePeer ? { safePeer: result.safePeer } : {}),
      question: result.question,
      message: result.message
    };
  }

  return {
    completed: true,
    threadId: result.threadId,
    requestId: result.requestId,
    peer: result.peer,
    ...(result.safePeer ? { safePeer: result.safePeer } : {}),
    question: result.question,
    summary: result.summary,
    findings: result.findings,
    references: result.references
  };
}

export interface PairMeshFollowUpResult {
  completed: boolean;
  status?: "working";
  threadId: string;
  requestId: string;
  peer: string;
  safePeer?: {
    participantId: string;
    displayName: string;
    service?: string;
  };
  question: string;
  summary?: string;
  findings?: string[];
  references?: import("@pairmesh/protocol").PairMeshSourceReference[];
  message?: string;
}

export async function followUpPairMeshInspection(
  sessionManager: SessionManager,
  threadId: string,
  question: string
): Promise<PairMeshFollowUpResult> {
  const parsedThreadId = InspectionThreadIdSchema.safeParse(threadId.trim());
  const trimmedQuestion = question.trim();
  if (!parsedThreadId.success || !trimmedQuestion) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Thread id and question are required.",
      details: { field: parsedThreadId.success ? "question" : "threadId" }
    });
  }

  const result = await sessionManager.followUpInspection(parsedThreadId.data, trimmedQuestion);
  if (!result.completed) {
    return {
      completed: false,
      status: "working",
      threadId: result.threadId,
      requestId: result.requestId,
      peer: result.peer,
      ...(result.safePeer ? { safePeer: result.safePeer } : {}),
      question: result.question,
      message: result.message
    };
  }

  return {
    completed: true,
    threadId: result.threadId,
    requestId: result.requestId,
    peer: result.peer,
    ...(result.safePeer ? { safePeer: result.safePeer } : {}),
    question: result.question,
    summary: result.summary,
    findings: result.findings,
    references: result.references
  };
}

export interface PairMeshListThreadsResult {
  threads: InspectionThreadSummary[];
}

export async function listPairMeshThreads(
  sessionManager: SessionManager,
  peer?: string
): Promise<PairMeshListThreadsResult> {
  const threads = await sessionManager.listInspectionThreads(peer?.trim() || undefined);
  return { threads };
}

export async function getPairMeshThread(
  sessionManager: SessionManager,
  threadId: string
): Promise<InspectionThreadDetail> {
  const parsed = InspectionThreadIdSchema.safeParse(threadId.trim());
  if (!parsed.success) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Invalid inspection thread id.",
      details: { threadId }
    });
  }
  return await sessionManager.getInspectionThread(parsed.data);
}

export async function closePairMeshThread(
  sessionManager: SessionManager,
  threadId: string
): Promise<{ threadId: string; status: "closed" }> {
  const parsed = InspectionThreadIdSchema.safeParse(threadId.trim());
  if (!parsed.success) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Invalid inspection thread id.",
      details: { threadId }
    });
  }
  await sessionManager.closeInspectionThread(parsed.data);
  return { threadId: parsed.data, status: "closed" };
}

export type PairMeshPeerHealthResult = PeerHealthResult & {
  member: true;
  relationship: SafePeerView["relationship"];
  connectivity: SafePeerView["connectivity"];
  agent?: SafePeerView["agent"];
};

export async function getPairMeshPeerHealth(
  sessionManager: SessionManager,
  peer: string
): Promise<PairMeshPeerHealthResult> {
  const trimmedPeer = peer.trim();
  if (!trimmedPeer) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer is required.",
      details: { field: "peer" }
    });
  }
  const safePeer = await sessionManager.getSafePeer(trimmedPeer);
  const health = await sessionManager.getPeerHealth(trimmedPeer);
  return {
    ...health,
    member: true,
    relationship: safePeer.relationship,
    connectivity: safePeer.connectivity,
    ...(safePeer.agent ? { agent: safePeer.agent } : {})
  };
}

export async function getPairMeshInspectionStatus(
  sessionManager: SessionManager,
  requestId: string
): Promise<Record<string, unknown>> {
  const trimmed = requestId.trim();
  if (!trimmed) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Request id is required.",
      details: { field: "requestId" }
    });
  }
  return await sessionManager.getInspectionStatus(trimmed);
}

export async function cancelPairMeshInspection(
  sessionManager: SessionManager,
  requestId: string
): Promise<{ requestId: string; cancelled: boolean }> {
  const trimmed = requestId.trim();
  if (!trimmed) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Request id is required.",
      details: { field: "requestId" }
    });
  }
  return await sessionManager.cancelInspection(trimmed);
}

export async function waitForPairMeshInspection(
  sessionManager: SessionManager,
  requestId: string,
  waitMs?: number
): Promise<WaitForInspectionResult> {
  const trimmed = requestId.trim();
  if (!trimmed) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Request id is required.",
      details: { field: "requestId" }
    });
  }

  return await sessionManager.waitForInspection(trimmed, { waitMs });
}

/** Reject remote-controlled process identity for tests.run (profile name only). */
export function assertTestsRunProfileOnly(parameters: Record<string, unknown>): void {
  for (const key of FORBIDDEN_TESTS_RUN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parameters, key) && parameters[key] !== undefined) {
      throw createPairMeshError({
        code: "pairmesh.invalid_metadata",
        message:
          "tests.run accepts only a receiver-owned profile name; executable/args/cwd/env are not allowed from the requester.",
        details: { field: key }
      });
    }
  }
}

function requireActionId(actionId: string): string {
  const parsed = ActionIdSchema.safeParse(actionId.trim());
  if (!parsed.success) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Invalid action id.",
      details: { field: "actionId", actionId }
    });
  }
  return parsed.data;
}

function withApprovalMessage<T extends { status: string; message?: string }>(view: T): T {
  if (view.status === "approval_required" && !view.message) {
    return { ...view, message: APPROVAL_REQUIRED_MESSAGE };
  }
  return view;
}

export function presentActionWire(
  wire: PairMeshActionWireSuccessResponse
): PairMeshActionWireSuccessResponse & { message?: string } {
  return withApprovalMessage(wire);
}

export function presentActionSafeView(view: ActionSafeView): ActionSafeView & { message?: string } {
  return withApprovalMessage(view);
}

export async function proposePairMeshChange(
  sessionManager: SessionManager,
  peer: string,
  instruction: string
): Promise<PairMeshActionWireSuccessResponse & { message?: string }> {
  const trimmedPeer = peer.trim();
  const trimmedInstruction = instruction.trim();
  if (!trimmedPeer || !trimmedInstruction) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer and instruction are required.",
      details: { field: trimmedPeer ? "instruction" : "peer" }
    });
  }

  const wire = await sessionManager.requestPeerAction({
    peerRef: trimmedPeer,
    actionType: "change.propose",
    parameters: { instruction: trimmedInstruction }
  });
  return presentActionWire(wire);
}

/**
 * Natural requester orchestration for Cursor / AI clients.
 * Requires explicit intent — never silently turns inspect into propose/apply.
 * Proposal never auto-applies; there is no approve capability on MCP.
 */
export async function askPairMeshNatural(
  sessionManager: SessionManager,
  peer: string,
  request: string,
  intent: "inspect" | "propose" | "goal",
  waitMs?: number
): Promise<CollaborateAskResult> {
  return collaborateAsk(sessionManager, {
    peerRef: peer,
    request,
    intent,
    ...(waitMs !== undefined ? { waitMs } : {})
  });
}

export async function requestPairMeshApply(
  sessionManager: SessionManager,
  peer: string,
  artifactId: string,
  contentHash: string
): Promise<PairMeshActionWireSuccessResponse & { message?: string }> {
  const trimmedPeer = peer.trim();
  const parsedArtifact = ArtifactIdSchema.safeParse(artifactId.trim());
  const hash = contentHash.trim().toLowerCase();
  if (!trimmedPeer || !parsedArtifact.success || !/^[a-f0-9]{64}$/.test(hash)) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer, artifact id, and sha256 content hash are required.",
      details: {
        field: !trimmedPeer ? "peer" : !parsedArtifact.success ? "artifactId" : "contentHash"
      }
    });
  }

  const wire = await sessionManager.requestPeerAction({
    peerRef: trimmedPeer,
    actionType: "repository.edit",
    artifactRef: {
      artifactId: parsedArtifact.data,
      contentHash: hash,
      artifactType: "patch_diff"
    }
  });
  return presentActionWire(wire);
}

export async function runPairMeshTests(
  sessionManager: SessionManager,
  peer: string,
  profile: string,
  rawParameters: Record<string, unknown> = {}
): Promise<PairMeshActionWireSuccessResponse & { message?: string }> {
  assertTestsRunProfileOnly(rawParameters);
  const trimmedPeer = peer.trim();
  const trimmedProfile = profile.trim();
  if (!trimmedPeer || !trimmedProfile) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer and profile name are required.",
      details: { field: trimmedPeer ? "profile" : "peer" }
    });
  }

  const wire = await sessionManager.requestPeerAction({
    peerRef: trimmedPeer,
    actionType: "tests.run",
    parameters: { profile: trimmedProfile }
  });
  return presentActionWire(wire);
}

export function assertProcessExecuteStructuredOnly(parameters: Record<string, unknown>): void {
  const forbidden = [
    "command",
    "shell",
    "env",
    "environment",
    "stdin",
    "tty",
    "approval",
    "allow_session",
    "allowSession",
    "script",
    "path",
    "executableAbsolute"
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(parameters, key)) {
      throw createPairMeshError({
        code: "pairmesh.process_request_invalid",
        message: `pairmesh_execute_process must not supply '${key}'.`
      });
    }
  }
}

export async function executePairMeshProcess(
  sessionManager: SessionManager,
  peer: string,
  executable: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
  rawParameters: Record<string, unknown> = {}
): Promise<PairMeshActionWireSuccessResponse & { message?: string }> {
  assertProcessExecuteStructuredOnly(rawParameters);
  const trimmedPeer = peer.trim();
  const trimmedExe = executable.trim();
  if (!trimmedPeer || !trimmedExe) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Peer and executable basename are required.",
      details: { field: trimmedPeer ? "executable" : "peer" }
    });
  }
  const parameters: Record<string, string | number | string[]> = {
    executable: trimmedExe,
    args
  };
  if (options.cwd) {
    parameters.cwd = options.cwd;
  }
  if (options.timeoutMs !== undefined) {
    parameters.timeoutMs = options.timeoutMs;
  }
  const wire = await sessionManager.requestPeerAction({
    peerRef: trimmedPeer,
    actionType: "process.execute",
    parameters
  });
  return presentActionWire(wire);
}

export async function getPairMeshActionStatus(
  sessionManager: SessionManager,
  actionId: string
): Promise<ActionSafeView & { message?: string }> {
  const id = requireActionId(actionId);
  try {
    return presentActionSafeView(await sessionManager.getPeerActionStatus(id));
  } catch {
    return presentActionSafeView(await sessionManager.getAction(id));
  }
}

export async function waitForPairMeshAction(
  sessionManager: SessionManager,
  actionId: string,
  waitMs?: number
): Promise<{
  action: ActionSafeView & { message?: string };
  timedOut: boolean;
  completed: boolean;
}> {
  const id = requireActionId(actionId);
  const resolvedWait =
    typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs > 0
      ? Math.floor(waitMs)
      : DEFAULT_ACTION_WAIT_MS;
  const result = await sessionManager.waitForAction(id, { waitMs: resolvedWait });
  const action = presentActionSafeView(result.action);
  return {
    action,
    timedOut: result.timedOut,
    completed: action.terminal && !result.timedOut
  };
}

export async function cancelPairMeshAction(
  sessionManager: SessionManager,
  actionId: string
): Promise<ActionSafeView & { message?: string }> {
  const id = requireActionId(actionId);
  const [status, local] = await Promise.all([
    sessionManager.getSessionStatus(),
    sessionManager.getAction(id)
  ]);
  const localId = status.localParticipant.participant.id;
  if (local.targetParticipantId === localId) {
    return presentActionSafeView(await sessionManager.cancelLocalAction(id));
  }
  return presentActionSafeView(await sessionManager.cancelPeerAction(id));
}
