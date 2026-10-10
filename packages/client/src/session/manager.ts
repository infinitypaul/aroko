import {
  ActionIdSchema,
  CollaborativeTaskEventIdSchema,
  CollaborativeTaskIdSchema,
  createPairMeshError,
  generateSessionCode,
  InputRequestIdSchema,
  InspectionExecutionRecordSchema,
  IsoUtcTimestampSchema,
  PAIRMESH_METADATA_VERSION,
  PairMeshSessionParticipantSchema,
  PairMeshSessionSchema,
  PeerIdSchema,
  SessionCodeSchema,
  SessionIdSchema,
  type ActionArtifactRef,
  type ActionExecutionRecord,
  type ActionId,
  type ActionParameters,
  type ArtifactId,
  type InspectionExecutionRecord,
  type InspectionThreadId,
  PairMeshInviteSecretSchema,
  type PairMeshActionWireSuccessResponse,
  type PairMeshError,
  type PairMeshInviteSecret,
  type PairMeshSession,
  type PairMeshSourceReference,
  type PeerHealthResult,
  type SessionCode
} from "@pairmesh/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { generateBearerToken } from "../auth/secrets.js";
import {
  createInvite,
  assertCanMintOpenInvite,
  revokeInviteById,
  isInviteRedeemable
} from "../auth/invites.js";
import { revokeInboundCredentials } from "../auth/credentials.js";
import {
  createSessionSecurity,
  describeSessionSecurity,
  requireOutboundBearer,
  requireSessionSecurity,
  type SessionSecurityView
} from "../auth/session-security.js";
import {
  decidePermissionRequest,
  ensureDefaultGrants,
  getGrantPolicy,
  isGrantableCapability,
  listGrantsForPeer,
  listPendingPermissionRequests,
  revokeParticipantCapabilities,
  setGrantPolicy
} from "../auth/capabilities.js";
import type {
  CapabilityGrantPolicy,
  PairMeshGrantableCapabilityId,
  PairMeshPermissionRequest,
  ParticipantCapabilityGrant,
  PermissionDecisionValue
} from "@pairmesh/protocol";
import { buildJoinRequest, sendPairMeshJoinRequest } from "../a2a/pairing-client.js";
import {
  buildInspectionRequest,
  runPairMeshInspectionInteractive,
  waitForPairMeshInspectionTask,
  cancelPairMeshInspectionTask
} from "../a2a/inspection-client.js";
import { sendA2AMessage, type A2ASendResult } from "../a2a/adapter.js";
import { sendPairMeshActionRequest } from "../a2a/action-client.js";
import { sendPairMeshTaskRequest } from "../a2a/task-client.js";
import {
  CollaborativeTaskService,
  InputRequestService,
  mintCollaborativeTaskEventId,
  HostRequestBridge,
  ContinuationOrchestrator,
  createGoalTaskWorker,
  FakeTaskWorker,
  type GoalProviderId,
  type DispatchTurnResult
} from "../collaboration/index.js";
import { createLocalPairMeshIdentity, normalizeAgentBaseUrl } from "../identity.js";
import { ActionService } from "../action/service.js";
import { CodingAgentProposalGenerator } from "../action/proposal/coding-agent-generator.js";
import { isTerminalActionStatus } from "../action/lifecycle.js";
import type { LocalProposalView } from "../action/proposal/index.js";
import {
  buildActionMirrorFromWire,
  findActionExecution,
  findLinkedActionForPermission,
  listPendingActionExecutions,
  toActionSafeView,
  upsertMirroredActionFromWire,
  type ActionSafeView
} from "../action/session-bridge.js";
import { LazyCodingAgentAdapter } from "../coding-agent/lazy-adapter.js";
import { loadConfigFile } from "../local-config/resolver.js";
import { configFilePath } from "../local-config/paths.js";
import { buildExecutionProviderSnapshot } from "../execution/provider-snapshot.js";
import { joinResponseToLocalState, mergeRelationshipIntoLocalState } from "./handshake-server.js";
import { listReceiverActionViews, type ReceiverActionListFilter } from "./receiver-actions.js";
import {
  listReceiverInspectionViews,
  toInspectionSafeView,
  type InspectionSafeView,
  type ReceiverInspectionListFilter
} from "./receiver-inspections.js";
import { listRequesterActionViews } from "../collaboration/requester-actions.js";
import { isPairedWithLocal, peerRelationshipStatus } from "./relationship.js";
import {
  closeThreadRecord,
  createInitiatorThreadRecord,
  listInspectionThreads,
  requireInitiatorThread
} from "../inspect/thread-store.js";
import {
  attachA2ATaskReference,
  completeExecutionRecord,
  createExecutionRecord,
  findExecutionRecord,
  findRecentDuplicateExecution,
  findResumableApprovalRequiredExecution,
  setExecutionLocalWaitState,
  updateExecutionProgress,
  upsertExecutionRecord
} from "../inspect/execution-store.js";
import {
  applySuccessfulRemoteResponse,
  buildInspectionStatusView,
  syncExecutionFromRemoteTask
} from "../inspect/remote-sync.js";
import {
  formatInspectionDuplicateWorkingMessage,
  formatInspectionStillWorkingMessage,
  formatInspectionTransportUnavailableMessage,
  formatInspectionWaitExpiredMessage,
  formatInspectionWorkingMessage
} from "../inspect/messages.js";
import {
  clampInspectionWaitMs,
  loadInspectionTimingFromEnv,
  type InspectionTimingConfig
} from "../inspect/timing.js";
import { projectPeerAgentStatus, projectPeerConnectivity } from "../health/peer-connectivity.js";
import {
  assertPeerReadyForInspection,
  fetchPeerHealth,
  invalidatePeerHealthCache
} from "../health/peer-health.js";
import { getRuntimeRelayBridge } from "../connectivity/relay-runtime.js";
import { LocalStateStore } from "../state/store.js";
import {
  clearRelayRoute,
  loadRelayRoute,
  relayRouteFileFromStateFile
} from "../connectivity/relay-route-store.js";
import {
  AuditLog,
  buildAuditEvent,
  buildResultSharedMetadata,
  mapAuthFailureReason
} from "../audit/index.js";
import type { PairMeshAuditEvent } from "@pairmesh/protocol";
import {
  LOCAL_STATE_VERSION,
  type LocalParticipantRecord,
  type LocalSessionState
} from "./schemas.js";
import {
  assertPairedForAsk,
  listSafePeers as buildSafePeerList,
  normalizeServiceLabel,
  resolvePeerTarget,
  toSafePeerMeta,
  toSafePeerView,
  type SafePeerMeta,
  type SafePeerView
} from "./peer-view.js";

export interface SessionManagerOptions {
  stateStore?: LocalStateStore;
  skipPeerHealthPreflight?: boolean;
  inspectionTiming?: InspectionTimingConfig;
  /** Local metadata-only audit log. Defaults to `.pairmesh/audit/` beside the state file. */
  auditLog?: AuditLog;
  /** Receiver workspace root for ActionService propose/edit/tests. */
  workspaceRoot?: string;
  /** Injected ActionService (tests). When omitted, lazily created from state + workspace. */
  actionService?: ActionService;
}

export interface RequestPeerActionInput {
  peerRef: string;
  actionType: string;
  parameters?: ActionParameters;
  artifactRef?: ActionArtifactRef;
  actionId?: ActionId;
}

export interface WaitForActionOptions {
  waitMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export type { ActionSafeView };

export interface CreateSessionInput {
  name: string;
  agentUrl: string;
    initialGrants?: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>;
  /**
   * Optional safe local service/project label (selector only, not a security principal).
   * Join A2A payload does not carry serviceLabel yet — local-only for create/join inputs.
   */
  serviceLabel?: string;
}

export interface JoinSessionInput {
  sessionCode: string;
  peerUrl: string;
  name: string;
  agentUrl: string;
  /** Single-use invite secret from the creator's `pairmesh create` / `invite`. */
  inviteSecret: string;
  /**
   * Optional safe local service/project label (selector only).
   * Join A2A payload does not carry serviceLabel yet — applied only to the local participant
   * record after join; remote peers' labels are not exchanged over the wire in alpha.
   */
  serviceLabel?: string;
}

export interface SessionInviteListItem {
  invitationId: string;
  expiresAt: string;
  status: "open" | "used" | "revoked" | "expired";
  createdAt: string;
}

/** Establish a pairwise relationship while already in the same collaboration. */
export interface EstablishRelationshipInput {
  peerUrl: string;
  inviteSecret: string;
}

export interface SessionStatusView {
  sessionCode: SessionCode;
  sessionId: string;
  status: PairMeshSession["status"];
  createdAt: string;
  localParticipant: LocalParticipantRecord;
  peers: LocalParticipantRecord[];
  security: SessionSecurityView;
}

export interface SessionInviteView {
  sessionCode: SessionCode;
  /** Plaintext invite secret. Shown once; only its hash is persisted. */
  inviteSecret: PairMeshInviteSecret;
  expiresAt: string;
  /** Opaque invite id for revoke/list without exposing the secret. */
  invitationId?: string;
}

export type CreateSessionResult = SessionStatusView & { invite: SessionInviteView };

export interface PeerInspectionCompletedResult {
  completed: true;
  threadId: string;
  peer: string;
  /** Safe peer metadata (identity selectors only — never secrets). */
  safePeer?: SafePeerMeta;
  requestId: string;
  question: string;
  summary: string;
  findings: string[];
  references: PairMeshSourceReference[];
}

export interface PeerInspectionWorkingResult {
  completed: false;
  status: "working" | "failed" | "timed_out" | "cancelled";
  lifecycle?: InspectionRequesterLifecycle;
  threadId: string;
  peer: string;
  safePeer?: SafePeerMeta;
  requestId: string;
  question: string;
  message: string;
  progressEvents?: InspectionExecutionRecord["progressEvents"];
  error?: { code: string; message: string };
}

export interface PeerInspectionApprovalRequiredResult {
  completed: false;
  status: "approval_required";
  threadId: string;
  peer: string;
  safePeer?: SafePeerMeta;
  requestId: string;
  question: string;
  permissionRequestId: string;
  capability: string;
  message: string;
}

export type PeerInspectionResult =
  | PeerInspectionCompletedResult
  | PeerInspectionWorkingResult
  | PeerInspectionApprovalRequiredResult;

export interface WaitForInspectionOptions {
  waitMs?: number;
  signal?: AbortSignal;
  /**
   * When true (default), clamp wait to MCP max (~8s) for Cursor tool timeouts.
   * CLI / collaborateAsk must pass false so --wait-ms is honored up to maxDurationMs.
   */
  clampToMcpMax?: boolean;
}

export type InspectionRequesterLifecycle =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "requester_wait_expired"
  | "peer_transport_unavailable";

export interface WaitForInspectionResult {
  completed: boolean;
  requestId: string;
  threadId: string;
  status: InspectionExecutionRecord["status"] | "working";
  /** Typed lifecycle — wait expiry is not remote failure. */
  lifecycle: InspectionRequesterLifecycle;
  peer?: string;
  safePeer?: SafePeerMeta;
  result?: {
    summary: string;
    findings: string[];
    references: PairMeshSourceReference[];
  };
  message?: string;
  /** Requester-safe progress snapshot accumulated via A2A polls. */
  progressEvents?: InspectionExecutionRecord["progressEvents"];
  error?: { code: string; message: string };
}

export interface InspectionThreadSummary {
  id: string;
  peer: string;
  status: "active" | "closed";
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  topic?: string;
}

export interface InspectionThreadDetail {
  id: string;
  peer: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
  topic?: string;
  turns: Array<{
    requestId: string;
    question: string;
    createdAt: string;
    summary?: string;
    findings?: string[];
    references?: PairMeshSourceReference[];
  }>;
}

/** Bounded retention of spent invites so replays get a precise error code. */
const INVITE_HISTORY_LIMIT = 20;

function requireActiveState(state: LocalSessionState): LocalSessionState {
  if (state.session.status === "closed") {
    throw createPairMeshError({
      code: "pairmesh.session_closed",
      message: "The local PairMesh session is closed.",
      details: { sessionCode: state.sessionCode }
    });
  }
  return state;
}

function mergeActionResultIntoLatest(
  latest: LocalSessionState,
  resultState: LocalSessionState,
  execution: ActionExecutionRecord
): LocalSessionState {
  const artifacts = [...(latest.actionArtifacts ?? [])];
  for (const artifact of resultState.actionArtifacts ?? []) {
    if (!artifacts.some((entry) => entry.artifactId === artifact.artifactId)) {
      artifacts.push(artifact);
    }
  }
  return {
    ...latest,
    actionExecutions: [
      ...(latest.actionExecutions ?? []).filter((entry) => entry.actionId !== execution.actionId),
      execution
    ],
    actionArtifacts: artifacts
  };
}

export class SessionManager {
  private readonly stateStore: LocalStateStore;
  private readonly skipPeerHealthPreflight: boolean;
  private readonly inspectionTiming: InspectionTimingConfig;
  private readonly auditLog: AuditLog;
  private readonly workspaceRoot?: string;
  private readonly injectedActionService?: ActionService;
  private lazyActionService?: ActionService;
  private lazyContinuationOrchestrator?: ContinuationOrchestrator;
  private readonly activeOutbound = new Map<string, AbortController>();
  private ownerPresence?: import("../notify/owner-presence.js").OwnerPresence;
  /** Serialize creator pairwise egress binds so concurrent hellos cannot swap peers. */
  private presenceBindQueue: Promise<void> = Promise.resolve();

  public constructor(options: SessionManagerOptions = {}) {
    this.stateStore = options.stateStore ?? new LocalStateStore();
    this.skipPeerHealthPreflight = options.skipPeerHealthPreflight ?? false;
    this.inspectionTiming = options.inspectionTiming ?? loadInspectionTimingFromEnv();
    this.auditLog = options.auditLog ?? AuditLog.fromStateFile(this.stateStore.stateFilePath);
    this.workspaceRoot = options.workspaceRoot;
    this.injectedActionService = options.actionService;
  }

    public attachOwnerPresence(presence: import("../notify/owner-presence.js").OwnerPresence): void {
    this.ownerPresence = presence;
    this.getActionService().setOnActionRecordChange(({ previous, next }) => {
      void this.dispatchOwnerPresence(previous, next);
    });
  }

  private async dispatchOwnerPresence(
    previous: import("@pairmesh/protocol").ActionExecutionRecord | undefined,
    next: import("@pairmesh/protocol").ActionExecutionRecord
  ): Promise<void> {
    if (!this.ownerPresence) {
      return;
    }
    try {
      const state = await this.stateStore.load();
      if (!state) {
        return;
      }
      await this.ownerPresence.handleActionTransition({ state, previous, next });
    } catch {
      // never break action path
    }
  }

  /** Exposes audit health for doctor without reading event contents. */
  public getAuditHealth() {
    return this.auditLog.getHealth();
  }

  public async listAuditEvents(limit = 50) {
    await this.auditLog.flush();
    return await this.auditLog.readRecent(limit);
  }

  /** Await pending audit writes (tests). */
  public async flushAudit(): Promise<void> {
    await this.auditLog.flush();
  }

  public async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const existing = await this.stateStore.load();
    if (existing?.session.status === "active") {
      throw createPairMeshError({
        code: "pairmesh.session_invalid_state",
        message:
          "An active PairMesh session already exists locally. Leave it before creating another.",
        details: { sessionCode: existing.sessionCode }
      });
    }

    const agentUrl = normalizeAgentBaseUrl(input.agentUrl);
    const identity = createLocalPairMeshIdentity(input.name, agentUrl);
    const sessionId = SessionIdSchema.parse(`ses_${randomUUID()}`);
    const sessionCode = generateSessionCode(randomBytes(8));
    const createdAt = nowUtc();

    const session = PairMeshSessionSchema.parse({
      id: sessionId,
      createdBy: identity.developer.id,
      createdAt,
      status: "active"
    });

    const localParticipant = this.buildLocalParticipantRecord({
      session,
      identity,
      agentUrl,
      isLocal: true,
      serviceLabel: normalizeServiceLabel(input.serviceLabel)
    });

    const invite = createInvite({
      inviterParticipantId: localParticipant.participant.id,
      ...(input.initialGrants ? { initialGrants: input.initialGrants } : {})
    });
    const state: LocalSessionState = {
      stateVersion: LOCAL_STATE_VERSION,
      sessionCode,
      session,
      localParticipant,
      peers: [],
      inspectionThreads: [],
      inspectionExecutions: [],
      permissionRequests: [],
      actionExecutions: [],
      actionArtifacts: [],
      collaborativeTasks: [],
      inputRequests: [],
      hostToolCalls: [],
      providerTurns: [],
      continuationEvents: [],
      sessionSecurity: {
        ...createSessionSecurity(),
        invites: [invite.record]
      }
    };

    await this.stateStore.replaceEntireDocument(state);
    this.emitAudit(
      buildAuditEvent({
        eventType: "session.created",
        projectId: identity.project.id,
        sessionId: session.id,
        sessionCode,
        actor: {
          participantId: localParticipant.participant.id,
          agentId: localParticipant.agent.id,
          peerName: localParticipant.agent.name
        },
        metadata: {}
      })
    );
    this.emitAudit(
      buildAuditEvent({
        eventType: "invite.created",
        projectId: identity.project.id,
        sessionId: session.id,
        sessionCode,
        actor: {
          participantId: localParticipant.participant.id,
          agentId: localParticipant.agent.id,
          peerName: localParticipant.agent.name
        },
        metadata: { invitationId: invite.record.invitationId }
      })
    );
    return {
      ...this.toStatusView(state),
      invite: {
        sessionCode,
        inviteSecret: invite.secret,
        expiresAt: invite.record.expiresAt,
        invitationId: invite.record.invitationId
      }
    };
  }

    public async createSessionInvite(options?: {
    initialGrants?: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>;
  }): Promise<SessionInviteView> {
    let inviteSecret = "";
    let expiresAt = "";
    let invitationId = "";
    let audit:
      | {
          projectId: string;
          sessionId: string;
          sessionCode: string;
          actorParticipantId: string;
          actorAgentId: string;
          actorPeerName: string;
        }
      | undefined;

    const next = await this.stateStore.update((state) => {
      if (state.session.status === "closed") {
        throw createPairMeshError({
          code: "pairmesh.session_closed",
          message: "The local PairMesh session is closed.",
          details: { sessionCode: state.sessionCode }
        });
      }
      const security = requireSessionSecurity(state);
      assertCanMintOpenInvite(security);
      const invite = createInvite({
        inviterParticipantId: state.localParticipant.participant.id,
        ...(options?.initialGrants ? { initialGrants: options.initialGrants } : {})
      });
      inviteSecret = invite.secret;
      expiresAt = invite.record.expiresAt;
      invitationId = invite.record.invitationId;
      audit = {
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actorParticipantId: state.localParticipant.participant.id,
        actorAgentId: state.localParticipant.agent.id,
        actorPeerName: state.localParticipant.agent.name
      };
      return {
        ...state,
        sessionSecurity: {
          ...security,
          invites: [...security.invites.slice(-INVITE_HISTORY_LIMIT), invite.record]
        }
      };
    });

    await this.registerInviteRelayAccessToken(next.sessionCode, inviteSecret as never);
    if (audit) {
      this.emitAudit(
        buildAuditEvent({
          eventType: "invite.created",
          projectId: audit.projectId,
          sessionId: audit.sessionId,
          sessionCode: audit.sessionCode,
          actor: {
            participantId: audit.actorParticipantId,
            agentId: audit.actorAgentId,
            peerName: audit.actorPeerName
          },
          metadata: { invitationId }
        })
      );
    }
    return {
      sessionCode: next.sessionCode,
      inviteSecret: inviteSecret as never,
      expiresAt: expiresAt as never,
      invitationId: invitationId as never
    };
  }

  /**
   * List outstanding invite metadata without secrets or hashes.
   * Use `revokeSessionInvite(invitationId)` to revoke one invite.
   */
  public async listSessionInvites(): Promise<SessionInviteListItem[]> {
    const state = await this.requireActiveSession();
    const security = state.sessionSecurity;
    if (!security) {
      return [];
    }
    const now = new Date();
    return security.invites.map((invite) => {
      let status: SessionInviteListItem["status"];
      if (invite.revokedAt) {
        status = "revoked";
      } else if (invite.usedAt) {
        status = "used";
      } else if (isInviteRedeemable(invite, now)) {
        status = "open";
      } else {
        status = "expired";
      }
      return {
        invitationId: invite.invitationId,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        status
      };
    });
  }

    private async resolveCreatorRelayAttachCredentials(sessionCode: string): Promise<{
    relayWsUrl: string;
    relaySessionId: import("../connectivity/relay/frames.js").RelaySessionId;
    relayAccessToken: import("../connectivity/relay/frames.js").RelayAccessToken;
  } | null> {
    const normalized = sessionCode.trim().toUpperCase();
    const fromBridge = getRuntimeRelayBridge()?.getAttachCredentials?.();
    if (fromBridge && fromBridge.sessionCode.trim().toUpperCase() === normalized) {
      return {
        relayWsUrl: fromBridge.relayWsUrl,
        relaySessionId:
          fromBridge.relaySessionId as import("../connectivity/relay/frames.js").RelaySessionId,
        relayAccessToken:
          fromBridge.relayAccessToken as import("../connectivity/relay/frames.js").RelayAccessToken
      };
    }

    const route = await loadRelayRoute(relayRouteFileFromStateFile(this.stateStore.stateFilePath));
    if (
      !route ||
      route.sessionCode.trim().toUpperCase() !== normalized ||
      route.role !== "creator"
    ) {
      return null;
    }
    return {
      relayWsUrl: route.relayWsUrl,
      relaySessionId: route.relaySessionId,
      relayAccessToken: route.relayAccessToken
    };
  }

  private async registerInviteRelayAccessToken(
    sessionCode: string,
    inviteSecret: string
  ): Promise<void> {
    const attach = await this.resolveCreatorRelayAttachCredentials(sessionCode);
    if (!attach) {
      return;
    }
    try {
      const { deriveRelayAccessToken } = await import("../connectivity/relay/access-token.js");
      const { registerRemoteRelayAccessToken, relayWsUrlToHttpBase } =
        await import("../connectivity/relay/rendezvous-http.js");
      const newToken = deriveRelayAccessToken({
        inviteSecret,
        sessionCode,
        relaySessionId: attach.relaySessionId
      });
      if (newToken === attach.relayAccessToken) {
        return;
      }
      await registerRemoteRelayAccessToken({
        relayHttpBaseUrl: relayWsUrlToHttpBase(attach.relayWsUrl),
        relaySessionId: attach.relaySessionId,
        authorizingToken: attach.relayAccessToken,
        newToken
      });
      const { rememberAuthorizedRelayAccessToken, relayRouteFileFromStateFile } =
        await import("../connectivity/relay-route-store.js");
      await rememberAuthorizedRelayAccessToken(
        relayRouteFileFromStateFile(this.stateStore.stateFilePath),
        newToken
      );
    } catch {
      /* Relay may be local-mock without HTTP API; Stage 8 invite remains valid. */
    }
  }

  /** Revoke one open invite by id without affecting other outstanding invites. */
  public async revokeSessionInvite(invitationId: string): Promise<void> {
    const state = await this.stateStore.update((latest) => {
      requireActiveState(latest);
      const security = requireSessionSecurity(latest);
      return {
        ...latest,
        sessionSecurity: revokeInviteById(security, invitationId)
      };
    });
    this.emitAudit(
      buildAuditEvent({
        eventType: "invite.revoked",
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        metadata: { invitationId }
      })
    );
  }

  public async joinSession(input: JoinSessionInput): Promise<SessionStatusView> {
    const sessionCode = parseSessionCode(input.sessionCode);
    const existing = await this.stateStore.load();

    if (existing?.session.status === "active") {
      if (existing.sessionCode === sessionCode) {
        // Already in this collaboration. Prefer pair-later when a fresh invite is
        // presented; fall back to idempotent status if the invite cannot be redeemed
        // (e.g. duplicate join with a spent create-time invite).
        try {
          return await this.establishRelationship({
            peerUrl: input.peerUrl,
            inviteSecret: input.inviteSecret
          });
        } catch (error) {
          if (
            isPairMeshErrorLike(error) &&
            (error.code === "pairmesh.invite_used" ||
              error.code === "pairmesh.invite_invalid" ||
              error.code === "pairmesh.invite_expired")
          ) {
            return this.toStatusView(existing);
          }
          throw error;
        }
      }

      throw createPairMeshError({
        code: "pairmesh.session_invalid_state",
        message:
          "An active PairMesh session already exists locally. Leave it before joining another.",
        details: { sessionCode: existing.sessionCode }
      });
    }

    const localAgentUrl = normalizeAgentBaseUrl(input.agentUrl);
    const identity = createLocalPairMeshIdentity(input.name, localAgentUrl);
    const inviteSecret = parseInviteSecret(input.inviteSecret);
    // Minted before the handshake: the creator stores its hash so it can call
    // back into this agent once pairing completes.
    const offeredInboundBearer = generateBearerToken();

    const joinRequest = buildJoinRequest(sessionCode, identity, localAgentUrl, {
      inviteSecret,
      offeredInboundBearer
    });
    const response = await sendPairMeshJoinRequest(input.peerUrl, joinRequest);

    if (!response.accepted) {
      throw response.error;
    }

    const state = joinResponseToLocalState({
      response,
      localAgentId: identity.agent.id,
      offeredInboundBearer
    });
    // Join A2A payload does not carry serviceLabel yet — apply only locally.
    const localServiceLabel = normalizeServiceLabel(input.serviceLabel);
    const withThreads: LocalSessionState = {
      ...state,
      stateVersion: LOCAL_STATE_VERSION,
      localParticipant: localServiceLabel
        ? { ...state.localParticipant, serviceLabel: localServiceLabel }
        : state.localParticipant,
      inspectionThreads: state.inspectionThreads ?? [],
      inspectionExecutions: state.inspectionExecutions ?? [],
      permissionRequests: state.permissionRequests ?? [],
      actionExecutions: state.actionExecutions ?? [],
      actionArtifacts: state.actionArtifacts ?? [],
      // Route subsequent A2A through the transport URL that succeeded for join
      // (relay local egress in relay mode; peer URL otherwise).
      peers: state.peers.map((peer) => ({
        ...peer,
        a2aAgentUrl: normalizeAgentBaseUrl(input.peerUrl)
      }))
    };
    await this.stateStore.replaceEntireDocument(withThreads);
    const inviter = withThreads.peers.find((peer) => isPairedWithLocal(peer));
    this.emitAudit(
      buildAuditEvent({
        eventType: "peer.joined",
        projectId: withThreads.localParticipant.agent.projectId,
        sessionId: withThreads.session.id,
        sessionCode: withThreads.sessionCode,
        actor: {
          participantId: withThreads.localParticipant.participant.id,
          agentId: withThreads.localParticipant.agent.id,
          peerName: withThreads.localParticipant.agent.name
        },
        target: inviter
          ? {
              participantId: inviter.participant.id,
              agentId: inviter.agent.id,
              peerName: inviter.agent.name
            }
          : undefined,
        metadata: { peerName: inviter?.agent.name }
      })
    );
    return this.toStatusView(withThreads);
  }

  /**
   * Establish a pairwise relationship with another collaboration member using
   * their invite, without leaving the local collaboration or wiping other peers.
   */
  public async establishRelationship(
    input: EstablishRelationshipInput
  ): Promise<SessionStatusView> {
    const state = await this.requireActiveSession();
    requireSessionSecurity(state);
    const inviteSecret = parseInviteSecret(input.inviteSecret);
    const offeredInboundBearer = generateBearerToken();
    const identity = {
      developer: state.localParticipant.developer,
      device: state.localParticipant.device ?? {
        id: state.localParticipant.agent.deviceId,
        developerId: state.localParticipant.developer.id,
        name: `${state.localParticipant.agent.name}-device`,
        platform: "darwin" as const
      },
      agent: state.localParticipant.agent,
      project: {
        id: state.localParticipant.agent.projectId,
        name: state.localParticipant.agent.name
      }
    };
    const joinRequest = buildJoinRequest(
      state.sessionCode,
      identity,
      state.localParticipant.a2aAgentUrl,
      {
        inviteSecret,
        offeredInboundBearer
      },
      { peerId: state.localParticipant.participant.id }
    );

    const response = await sendPairMeshJoinRequest(input.peerUrl, joinRequest);
    if (!response.accepted) {
      throw response.error;
    }

    const peerTransportUrl = normalizeAgentBaseUrl(input.peerUrl);
    const merged = await this.stateStore.update((latest) =>
      mergeRelationshipIntoLocalState({
        state: requireActiveState(latest),
        response,
        offeredInboundBearer,
        peerTransportUrl
      })
    );
        // path to re-announce / re-bind so transport readiness follows without restart.
    void getRuntimeRelayBridge()
      ?.reconcilePeerTransports()
      .catch(() => {
        /* best-effort */
      });
    const paired = merged.peers.find(
      (peer) => isPairedWithLocal(peer) && peer.a2aAgentUrl === peerTransportUrl
    );
    this.emitAudit(
      buildAuditEvent({
        eventType: "peer.joined",
        projectId: merged.localParticipant.agent.projectId,
        sessionId: merged.session.id,
        sessionCode: merged.sessionCode,
        actor: {
          participantId: merged.localParticipant.participant.id,
          agentId: merged.localParticipant.agent.id,
          peerName: merged.localParticipant.agent.name
        },
        target: paired
          ? {
              participantId: paired.participant.id,
              agentId: paired.agent.id,
              peerName: paired.agent.name
            }
          : undefined,
        metadata: { peerName: paired?.agent.name }
      })
    );
    return this.toStatusView(merged);
  }

  /**
   * Revokes the local pairwise relationship with one peer. The peer remains a
   * known collaboration member (unpaired/revoked) — this is not a global kick.
   */
  public async removePeer(peerRef: string): Promise<{ peer: string; revokedCredentials: number }> {
    let peer!: LocalParticipantRecord;
    let revokedCredentials = 0;
    let priorGrants: ReturnType<typeof listGrantsForPeer> = [];
    const state = await this.stateStore.update((latest) => {
      requireActiveState(latest);
      const security = requireSessionSecurity(latest);
      const resolved = resolvePeerRecord(latest, peerRef);
      if (!resolved) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Peer not found in the active PairMesh session.",
          details: { peerRef }
        });
      }
      peer = resolved;
      const revokedSecurity = revokeInboundCredentials(security, peer.participant.id);
      revokedCredentials = revokedSecurity.acceptedInbound.filter(
        (credential) =>
          credential.participantId === peer.participant.id && credential.revokedAt !== undefined
      ).length;
      priorGrants = listGrantsForPeer(latest, peer.participant.id);
      const unpairedPeer: LocalParticipantRecord = {
        participant: peer.participant,
        agent: peer.agent,
        developer: peer.developer,
        device: peer.device,
        a2aAgentUrl: peer.a2aAgentUrl,
        isLocal: false,
        connectivity: peer.connectivity
        // outboundBearer intentionally omitted — relationship revoked locally
      };
      return revokeParticipantCapabilities(
        {
          ...latest,
          peers: latest.peers.map((candidate) =>
            candidate.participant.id === peer.participant.id ? unpairedPeer : candidate
          ),
          inspectionThreads: latest.inspectionThreads.filter(
            (thread) => thread.thread.targetPeerId !== peer.participant.id
          ),
          sessionSecurity: revokedSecurity
        },
        peer.participant.id
      );
    });
    this.emitAudit(
      buildAuditEvent({
        eventType: "peer.removed",
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        target: {
          participantId: peer.participant.id,
          agentId: peer.agent.id,
          peerName: peer.agent.name
        },
        metadata: {
          peerName: peer.agent.name,
          revokedCredentials
        }
      })
    );
    for (const grant of priorGrants) {
      this.emitAudit(
        buildAuditEvent({
          eventType: "capability.revoked",
          projectId: state.localParticipant.agent.projectId,
          sessionId: state.session.id,
          sessionCode: state.sessionCode,
          actor: {
            participantId: state.localParticipant.participant.id,
            agentId: state.localParticipant.agent.id,
            peerName: state.localParticipant.agent.name
          },
          target: {
            participantId: peer.participant.id,
            agentId: peer.agent.id,
            peerName: peer.agent.name
          },
          metadata: {
            capabilityId: grant.capabilityId,
            policy: grant.policy,
            scope: "session"
          }
        })
      );
    }
    return { peer: peer.agent.name, revokedCredentials };
  }

  public async getSessionStatus(): Promise<SessionStatusView> {
    const state = await this.requireActiveSession();
    return this.toStatusView(state);
  }

  /**
   * Safe peer rows for CLI / MCP / Control. Never includes secrets or paths.
   * Probes per-peer health (cached) unless `skipHealthProbe` is set.
   */
  public async listSafePeers(options?: { skipHealthProbe?: boolean }): Promise<SafePeerView[]> {
    const state = await this.requireActiveSession();
    const bridge = getRuntimeRelayBridge();
    const relayStatus = bridge?.getStatus();
    const relayLifecycle = relayStatus?.lifecycle ?? "idle";
    const relayMode = relayStatus?.mode === "relay" && relayLifecycle !== "idle";
    const creatorRouteAuthority = relayMode && relayStatus?.role === "creator";

    const connectivityByParticipantId: Record<string, SafePeerView["connectivity"]> = {};
    const agentByParticipantId: Record<string, SafePeerView["agent"]> = {};

    for (const peer of state.peers) {
      const relationship = peerRelationshipStatus(state, peer);
      let health: PeerHealthResult | undefined;

      const shouldProbe =
        !options?.skipHealthProbe &&
        isPairedWithLocal(peer) &&
        (relationship === "paired" || relationship === "revoked");

      if (shouldProbe) {
        health = await fetchPeerHealth(peer.agent.name, peer.a2aAgentUrl, {
          bearerToken: peer.outboundBearer
        });
      }

      const presenceId = peer.connectivity?.relayPresenceId;
      // Presence-bound relay peers: READY only via CreatorPeerBinding (never façade /health).
      // CLI process has no bridge — still require verified route (doctor reads Control).
      const verifiedRouteRequired = Boolean(
        presenceId && (creatorRouteAuthority || !bridge || relayStatus?.role === "creator")
      );
      const routeHealth =
        verifiedRouteRequired && presenceId && bridge
          ? bridge.getPeerRouteHealth(presenceId)
          : undefined;

      connectivityByParticipantId[peer.participant.id] = projectPeerConnectivity({
        relationship,
        relayLifecycle,
        relayMode,
        health,
        ...(verifiedRouteRequired
          ? {
              verifiedRouteRequired: true,
              ...(routeHealth ? { routeHealth } : {})
            }
          : {})
      });
      const agent = projectPeerAgentStatus(health);
      if (agent) {
        agentByParticipantId[peer.participant.id] = agent;
      }
    }

    return buildSafePeerList(state, {
      connectivityByParticipantId,
      agentByParticipantId
    });
  }

  public async getSafePeer(
    peerRef: string,
    options?: { skipHealthProbe?: boolean }
  ): Promise<SafePeerView> {
    const state = await this.requireActiveSession();
    const { peer } = resolvePeerTarget(state, peerRef);
    const relationship = peerRelationshipStatus(state, peer);
    const bridge = getRuntimeRelayBridge();
    const relayStatus = bridge?.getStatus();
    const relayLifecycle = relayStatus?.lifecycle ?? "idle";
    const relayMode = relayStatus?.mode === "relay" && relayLifecycle !== "idle";
    const creatorRouteAuthority = relayMode && relayStatus?.role === "creator";

    let health: PeerHealthResult | undefined;
    const shouldProbe =
      !options?.skipHealthProbe &&
      isPairedWithLocal(peer) &&
      (relationship === "paired" || relationship === "revoked");

    if (shouldProbe) {
      health = await fetchPeerHealth(peer.agent.name, peer.a2aAgentUrl, {
        bearerToken: peer.outboundBearer
      });
    }

    const presenceId = peer.connectivity?.relayPresenceId;
    const verifiedRouteRequired = Boolean(
      presenceId && (creatorRouteAuthority || !bridge || relayStatus?.role === "creator")
    );
    const routeHealth =
      verifiedRouteRequired && presenceId && bridge
        ? bridge.getPeerRouteHealth(presenceId)
        : undefined;

    return toSafePeerView(state, peer, {
      connectivity: projectPeerConnectivity({
        relationship,
        relayLifecycle,
        relayMode,
        health,
        ...(verifiedRouteRequired
          ? {
              verifiedRouteRequired: true,
              ...(routeHealth ? { routeHealth } : {})
            }
          : {})
      }),
      agent: projectPeerAgentStatus(health)
    });
  }

  public async listPeerPermissions(peerRef?: string): Promise<
    Array<{
      peer: string;
      participantId: string;
      grants: ParticipantCapabilityGrant[];
    }>
  > {
    const state = await this.stateStore.update(async (latest) => {
      if (latest.session.status === "closed") {
        throw createPairMeshError({
          code: "pairmesh.session_closed",
          message: "The local PairMesh session is closed.",
          details: { sessionCode: latest.sessionCode }
        });
      }
      const peers = peerRef
        ? (() => {
            const peer = resolvePeerRecord(latest, peerRef);
            if (!peer) {
              throw createPairMeshError({
                code: "pairmesh.peer_not_found",
                message: "Peer not found in the active PairMesh session.",
                details: { peerRef }
              });
            }
            return [peer];
          })()
        : latest.peers;

      let security = requireSessionSecurity(latest);
      for (const peer of peers) {
        security = ensureDefaultGrants(security, peer.participant.id);
      }
      if (security === latest.sessionSecurity) {
        return latest;
      }
      return { ...latest, sessionSecurity: security };
    });

    const peers = peerRef
      ? (() => {
          const peer = resolvePeerRecord(state, peerRef);
          if (!peer) {
            throw createPairMeshError({
              code: "pairmesh.peer_not_found",
              message: "Peer not found in the active PairMesh session.",
              details: { peerRef }
            });
          }
          return [peer];
        })()
      : state.peers;

    return peers.map((peer) => ({
      peer: peer.agent.name,
      participantId: peer.participant.id,
      grants: listGrantsForPeer(state, peer.participant.id)
    }));
  }

  public async listPendingPermissions(): Promise<PairMeshPermissionRequest[]> {
    const state = await this.requireActiveSession();
    return listPendingPermissionRequests(state);
  }

  public async setPeerCapability(
    peerRef: string,
    capabilityId: string,
    policy: CapabilityGrantPolicy
  ): Promise<{
    peer: string;
    capabilityId: PairMeshGrantableCapabilityId;
    policy: CapabilityGrantPolicy;
  }> {
            if (!isGrantableCapability(capabilityId)) {
      throw createPairMeshError({
        code: "pairmesh.capability_not_allowed",
        message: `Unknown or unimplemented capability: ${capabilityId}`,
        details: { capabilityId }
      });
    }

    let previousPolicy: CapabilityGrantPolicy | undefined;
    let peerName = "";
    let peerParticipantId = "";
    let peerAgentId = "";
    let auditContext:
      | {
          projectId: string;
          sessionId: string;
          sessionCode: string;
          actorParticipantId: string;
          actorAgentId: string;
          actorPeerName: string;
        }
      | undefined;

    await this.stateStore.update((state) => {
      if (state.session.status === "closed") {
        throw createPairMeshError({
          code: "pairmesh.session_closed",
          message: "The local PairMesh session is closed.",
          details: { sessionCode: state.sessionCode }
        });
      }
      const peer = resolvePeerRecord(state, peerRef);
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Peer not found in the active PairMesh session.",
          details: { peerRef }
        });
      }
      previousPolicy = getGrantPolicy(state, peer.participant.id, capabilityId);
      peerName = peer.agent.name;
      peerParticipantId = peer.participant.id;
      peerAgentId = peer.agent.id;
      auditContext = {
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actorParticipantId: state.localParticipant.participant.id,
        actorAgentId: state.localParticipant.agent.id,
        actorPeerName: state.localParticipant.agent.name
      };
      return setGrantPolicy(state, peer.participant.id, capabilityId, policy);
    });

    if (previousPolicy !== policy && auditContext) {
      this.emitAudit(
        buildAuditEvent({
          eventType: policy === "deny" ? "capability.revoked" : "capability.granted",
          projectId: auditContext.projectId,
          sessionId: auditContext.sessionId,
          sessionCode: auditContext.sessionCode,
          actor: {
            participantId: auditContext.actorParticipantId,
            agentId: auditContext.actorAgentId,
            peerName: auditContext.actorPeerName
          },
          target: {
            participantId: peerParticipantId,
            agentId: peerAgentId,
            peerName: peerName
          },
          metadata: {
            capabilityId,
            policy,
            scope: "session"
          }
        })
      );
    }
    return { peer: peerName, capabilityId, policy };
  }

  public async decidePendingPermission(
    permissionRequestId: string,
    decision: PermissionDecisionValue
  ): Promise<PairMeshPermissionRequest> {
    let linkedExecution: ActionExecutionRecord | undefined;
    let resume:
      (() => Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }>) | undefined;
    const request = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      const pending = (state.permissionRequests ?? []).find(
        (entry) => entry.permissionRequestId === permissionRequestId
      );
      const linked = pending
        ? findLinkedActionForPermission(state, permissionRequestId, pending.correlationRequestId)
        : undefined;

      if (linked) {
        const actionDecision =
          decision === "allow-once"
            ? ("allow-once" as const)
            : decision === "allow-session"
              ? ("allow-session" as const)
              : ("deny" as const);
        const begun = await this.getActionService().approveActionBegin(state, {
          actionId: linked.actionId,
          decision: actionDecision
        });
        await this.stateStore.writeExclusive(begun.state);
        linkedExecution = begun.execution;
        resume = begun.resume;

        return (
          (begun.state.permissionRequests ?? []).find(
            (entry) => entry.permissionRequestId === permissionRequestId
          ) ??
          pending ??
          (() => {
            throw createPairMeshError({
              code: "pairmesh.permission_request_not_found",
              message: "Permission request not found after action decision."
            });
          })()
        );
      }

      const decided = decidePermissionRequest(state, permissionRequestId, decision);
      await this.stateStore.writeExclusive(decided.state);
      return decided.request;
    });

    if (resume) {
      const resumed = await resume();
      linkedExecution = resumed.execution;
      await this.stateStore.update((latest) =>
        mergeActionResultIntoLatest(latest, resumed.state, resumed.execution)
      );
    }
    const auditState = await this.stateStore.load();
    if (auditState) {
      this.emitPermissionDecisionAudit(auditState, request, decision);
      if (linkedExecution) {
        this.emitActionDecisionAudit(auditState, linkedExecution, decision);
        await this.afterCollaborativeActionTerminal(linkedExecution);
      }
    }
    return request;
  }

  public async listPendingActions(): Promise<ActionSafeView[]> {
    const state = await this.requireActiveSession();
    return listPendingActionExecutions(state).map((execution) =>
      toActionSafeView(state, execution)
    );
  }

  public async listReceiverActions(
    filter: ReceiverActionListFilter,
    limit = 50
  ): Promise<ActionSafeView[]> {
    const state = await this.requireActiveSession();
    return listReceiverActionViews(state, filter, limit);
  }

  public async listReceiverInspections(
    filter: ReceiverInspectionListFilter,
    limit = 50
  ): Promise<InspectionSafeView[]> {
    const state = await this.requireActiveSession();
    return listReceiverInspectionViews(state, filter, limit);
  }

  public async getInspection(requestId: string): Promise<InspectionSafeView> {
    const state = await this.requireActiveSession();
    const execution = findExecutionRecord(state, requestId);
    if (!execution || execution.ownerRole !== "receiver") {
      throw createPairMeshError({
        code: "pairmesh.inspection_not_found",
        message: "Inspection execution not found.",
        details: { requestId }
      });
    }
    return toInspectionSafeView(state, execution);
  }

  public async listRequesterActions(
    filter: import("../collaboration/requester-actions.js").RequesterActionListFilter = "all",
    limit = 50
  ): Promise<ActionSafeView[]> {
    const state = await this.requireActiveSession();
    return listRequesterActionViews(state, filter, limit);
  }

  public async getAction(actionId: string): Promise<ActionSafeView> {
    const state = await this.requireActiveSession();
    const execution = findActionExecution(state, actionId);
    if (!execution) {
      throw createPairMeshError({
        code: "pairmesh.action_not_found",
        message: "Action execution not found.",
        details: { actionId }
      });
    }
    return toActionSafeView(state, execution);
  }

  public async reviewActionProposal(actionIdOrArtifactId: string): Promise<LocalProposalView> {
    const state = await this.requireActiveSession();
    const service = this.getActionService();
    const asAction = findActionExecution(state, actionIdOrArtifactId);
    if (asAction) {
      return service.getProposal(state, { actionId: asAction.actionId });
    }
    return service.getProposal(state, {
      artifactId: actionIdOrArtifactId as ArtifactId
    });
  }

  public async approveAction(
    actionId: string,
    decision: "allow-once" | "allow-session" | "deny"
  ): Promise<ActionSafeView> {
    const begun = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      const result = await this.getActionService().approveActionBegin(state, {
        actionId: ActionIdSchema.parse(actionId),
        decision
      });
      await this.stateStore.writeExclusive(result.state);
      return result;
    });
    const result = begun.resume ? await begun.resume() : begun;
    if (begun.resume) {
      await this.stateStore.update((latest) =>
        mergeActionResultIntoLatest(latest, result.state, result.execution)
      );
    }
    const latest = await this.requireActiveSession();
    this.emitActionDecisionAudit(latest, result.execution, decision);
    if (result.execution.permissionRequestId) {
      const request = (latest.permissionRequests ?? []).find(
        (entry) => entry.permissionRequestId === result.execution.permissionRequestId
      );
      if (request) {
        this.emitPermissionDecisionAudit(latest, request, decision);
      }
    }
    await this.afterCollaborativeActionTerminal(result.execution);
    return toActionSafeView(latest, result.execution);
  }

  public async denyAction(actionId: string): Promise<ActionSafeView> {
    return this.approveAction(actionId, "deny");
  }

  public async cancelLocalAction(actionId: string): Promise<ActionSafeView> {
    let result!: ReturnType<ActionService["cancelAction"]>;
    const state = await this.stateStore.update((latest) => {
      requireActiveState(latest);
      result = this.getActionService().cancelAction(latest, ActionIdSchema.parse(actionId));
      return result.state;
    });
    if (result.execution.status === "cancelled") {
      this.emitAudit(
        buildAuditEvent({
          eventType: "action.cancelled",
          projectId: state.localParticipant.agent.projectId,
          sessionId: state.session.id,
          sessionCode: state.sessionCode,
          actor: {
            participantId: state.localParticipant.participant.id,
            agentId: state.localParticipant.agent.id,
            peerName: state.localParticipant.agent.name
          },
          correlation: { requestId: result.execution.actionId },
          metadata: {
            actionId: result.execution.actionId,
            actionType: result.execution.actionType,
            capabilityId: result.execution.capabilityId,
            status: result.execution.status,
            ...(result.execution.permissionRequestId
              ? { permissionRequestId: result.execution.permissionRequestId }
              : {})
          }
        })
      );
    }
    await this.afterCollaborativeActionTerminal(result.execution);
    return toActionSafeView(result.state, result.execution);
  }

  /**
   * R5-8-D3 — When an Action linked to a CollaborativeTask reaches a terminal
   * status, observe it so the task leaves blocked_on_action, then continue the
   * provider turn. Without this, Approve Once can complete the Action while Live
   * stays "Waiting for approval" and Needs you goes empty.
   */
  private async afterCollaborativeActionTerminal(
    execution: import("@pairmesh/protocol").ActionExecutionRecord
  ): Promise<void> {
    if (!execution.taskId || !isTerminalActionStatus(execution.status)) {
      return;
    }
    let event: Awaited<ReturnType<ContinuationOrchestrator["observeActionTerminal"]>> = null;
    try {
      event = await this.getContinuationOrchestrator().observeActionTerminal(execution);
    } catch {
      return;
    }
    if (!event) {
      return;
    }
    const providerId = await this.resolveGoalProviderId();
    const workspaceRoot = this.workspaceRoot ?? process.cwd();
    const worker = createGoalTaskWorker({
      providerId,
      workspaceRoot,
      ...(providerId === "fake"
        ? {
            fakeWorker: new FakeTaskWorker({
              instanceId: `action-continue-${execution.actionId}`,
              script: [
                {
                  kind: "completed",
                  summary: "Continuation after Action terminal (default Fake)."
                }
              ]
            })
          }
        : {}),
      disableCursorSessionReuse: true
    });
    const orchestrator = this.getContinuationOrchestrator(worker);
    void orchestrator.continueTask(event.taskId).catch(() => {
      // Durable working + ContinuationEvent remain; pairmesh task continue can retry.
    });
  }

  public async requestPeerAction(
    input: RequestPeerActionInput
  ): Promise<PairMeshActionWireSuccessResponse> {
    const prep = await this.mutateSession(async (state) => {
      const peer = resolvePeerRecord(state, input.peerRef);
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Peer not found in the active PairMesh session.",
          details: { peerRef: input.peerRef }
        });
      }
      assertPairedForAsk(state, peer);
      const bearerToken = requireOutboundBearer(state, peer);
      const actionId = input.actionId ?? ActionIdSchema.parse(`act_${randomUUID()}`);
      return {
        peer,
        bearerToken,
        actionId,
        sessionId: state.session.id,
        localParticipantId: state.localParticipant.participant.id
      };
    });

    const wire = await sendPairMeshActionRequest(
      prep.peer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: prep.sessionId,
        operation: "request",
        actionId: prep.actionId,
        actionType: input.actionType,
        ...(input.parameters ? { parameters: input.parameters } : {}),
        ...(input.artifactRef ? { artifactRef: input.artifactRef } : {})
      },
      { bearerToken: prep.bearerToken }
    );

    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }

    await this.mutateSession((state) => {
      const mirror = buildActionMirrorFromWire(wire, {
        requesterParticipantId: prep.localParticipantId,
        targetParticipantId: prep.peer.participant.id,
        parameters: input.parameters,
        artifactRef: input.artifactRef
      });
      const upserted = upsertMirroredActionFromWire(state, mirror);
      state.actionExecutions = upserted.state.actionExecutions;
    });

    return wire;
  }

  public async getPeerActionStatus(actionId: string): Promise<ActionSafeView> {
    const prep = await this.mutateSession(async (state) => {
      const execution = findActionExecution(state, actionId);
      if (!execution) {
        throw createPairMeshError({
          code: "pairmesh.action_not_found",
          message: "Action execution not found.",
          details: { actionId }
        });
      }
      const peer = state.peers.find(
        (entry) => entry.participant.id === execution.targetParticipantId
      );
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Action target peer is not present in the local session.",
          details: { actionId, targetParticipantId: execution.targetParticipantId }
        });
      }
      assertPairedForAsk(state, peer);
      return {
        peer,
        bearerToken: requireOutboundBearer(state, peer),
        sessionId: state.session.id,
        actionId: execution.actionId,
        parameters: execution.parameters,
        artifactRef: execution.artifactRefs?.[0],
        localParticipantId: state.localParticipant.participant.id
      };
    });

    const wire = await sendPairMeshActionRequest(
      prep.peer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: prep.sessionId,
        operation: "status",
        actionId: prep.actionId
      },
      { bearerToken: prep.bearerToken }
    );

    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }

    return this.mutateSession((state) => {
      const mirror = buildActionMirrorFromWire(wire, {
        requesterParticipantId: prep.localParticipantId,
        targetParticipantId: prep.peer.participant.id,
        parameters: prep.parameters,
        artifactRef: prep.artifactRef
      });
      const upserted = upsertMirroredActionFromWire(state, mirror);
      state.actionExecutions = upserted.state.actionExecutions;
      return toActionSafeView(state, upserted.execution);
    });
  }

  public async waitForAction(
    actionId: string,
    options: WaitForActionOptions
  ): Promise<{ action: ActionSafeView; timedOut: boolean }> {
    const waitMs = Math.max(0, options.waitMs);
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 250);
    const started = Date.now();
    let last: ActionSafeView | undefined;

    while (Date.now() - started <= waitMs) {
      if (options.signal?.aborted) {
        throw createPairMeshError({
          code: "pairmesh.inspection_cancelled",
          message: "Action wait was cancelled."
        });
      }

      const state = await this.requireActiveSession();
      const local = findActionExecution(state, actionId);
      if (!local) {
        throw createPairMeshError({
          code: "pairmesh.action_not_found",
          message: "Action execution not found.",
          details: { actionId }
        });
      }

      if (isTerminalActionStatus(local.status)) {
        return { action: toActionSafeView(state, local), timedOut: false };
      }

      const isLocalReceiver = local.targetParticipantId === state.localParticipant.participant.id;
      if (!isLocalReceiver) {
        try {
          last = await this.getPeerActionStatus(actionId);
          if (last.terminal) {
            return { action: last, timedOut: false };
          }
        } catch {
          last = toActionSafeView(state, local);
        }
      } else {
        last = toActionSafeView(state, local);
      }

      const remaining = waitMs - (Date.now() - started);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(pollIntervalMs, remaining), options.signal);
    }

    if (!last) {
      const state = await this.requireActiveSession();
      const local = findActionExecution(state, actionId);
      if (!local) {
        throw createPairMeshError({
          code: "pairmesh.action_not_found",
          message: "Action execution not found.",
          details: { actionId }
        });
      }
      last = toActionSafeView(state, local);
    }
    return { action: last, timedOut: !last.terminal };
  }

  public async cancelPeerAction(actionId: string): Promise<ActionSafeView> {
    const prep = await this.mutateSession(async (state) => {
      const execution = findActionExecution(state, actionId);
      if (!execution) {
        throw createPairMeshError({
          code: "pairmesh.action_not_found",
          message: "Action execution not found.",
          details: { actionId }
        });
      }
      const peer = state.peers.find(
        (entry) => entry.participant.id === execution.targetParticipantId
      );
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Action target peer is not present in the local session.",
          details: { actionId }
        });
      }
      assertPairedForAsk(state, peer);
      return {
        peer,
        bearerToken: requireOutboundBearer(state, peer),
        sessionId: state.session.id,
        actionId: execution.actionId,
        parameters: execution.parameters,
        artifactRef: execution.artifactRefs?.[0],
        localParticipantId: state.localParticipant.participant.id
      };
    });

    const wire = await sendPairMeshActionRequest(
      prep.peer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: prep.sessionId,
        operation: "cancel",
        actionId: prep.actionId
      },
      { bearerToken: prep.bearerToken }
    );

    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }

    return this.mutateSession((state) => {
      const mirror = buildActionMirrorFromWire(wire, {
        requesterParticipantId: prep.localParticipantId,
        targetParticipantId: prep.peer.participant.id,
        parameters: prep.parameters,
        artifactRef: prep.artifactRef
      });
      const upserted = upsertMirroredActionFromWire(state, mirror);
      state.actionExecutions = upserted.state.actionExecutions;
      return toActionSafeView(state, upserted.execution);
    });
  }

  /** R5-2/R5-3: create a receiver-authoritative CollaborativeTask (local). */
  public async createCollaborativeTask(input: {
    originalGoal: string;
    requesterParticipantId?: string;
    ownerParticipantId?: string;
    threadId?: string;
  }) {
    const state = await this.requireActiveSession();
    const tasks = new CollaborativeTaskService(this.stateStore);
    return tasks.createTask({
      sessionId: state.session.id,
      requesterParticipantId:
        input.requesterParticipantId ??
        state.peers[0]?.participant.id ??
        state.localParticipant.participant.id,
      ownerParticipantId: input.ownerParticipantId ?? state.localParticipant.participant.id,
      originalGoal: input.originalGoal,
      ...(input.threadId ? { threadId: input.threadId } : {})
    });
  }

  /**
   * R5-3: create InputRequest on receiver and deliver to requester peer over A2A.
   * Does not invoke providers or create Actions.
   */
  public async createAndDeliverInputRequest(input: {
    taskId: string;
    question: string;
    options?: string[];
    allowFreeText?: boolean;
    /** Peer ref for the requester; defaults to task.requesterParticipantId. */
    requesterPeerRef?: string;
  }) {
    const inputs = new InputRequestService(this.stateStore);
    const tasks = new CollaborativeTaskService(this.stateStore);
    const created = await inputs.createInputRequest({
      taskId: input.taskId,
      question: input.question,
      options: input.options,
      allowFreeText: input.allowFreeText
    });

    const prep = await this.mutateSession(async (state) => {
      const peerRef = input.requesterPeerRef ?? created.task.requesterParticipantId;
      const peer = resolvePeerRecord(state, peerRef);
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Requester peer not found for InputRequest delivery.",
          details: { peerRef }
        });
      }
      return {
        peer,
        bearerToken: requireOutboundBearer(state, peer),
        sessionId: state.session.id
      };
    });

    const wire = await sendPairMeshTaskRequest(
      prep.peer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: prep.sessionId,
        operation: "input.deliver",
        taskId: created.task.taskId,
        inputRequest: inputs.toRequesterView(created.inputRequest),
        task: tasks.toRequesterView(created.task)
      },
      { bearerToken: prep.bearerToken }
    );
    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }
    return {
      task: created.task,
      inputRequest: created.inputRequest,
      delivered: true as const
    };
  }

  /** R5-3: answer a pending InputRequest (local authority if receiver, else A2A to owner). */
  public async answerCollaborativeInputRequest(input: {
    taskId?: string;
    inputRequestId: string;
    answer: string;
    answerEventId?: string;
  }) {
    const inputs = new InputRequestService(this.stateStore);
    const local = await inputs.getInputRequest(input.inputRequestId);
    const state = await this.requireActiveSession();
    const taskId = input.taskId ?? local?.taskId;
    if (!taskId) {
      throw createPairMeshError({
        code: "pairmesh.input_request_not_found",
        message: "InputRequest not found locally; provide taskId or receive a deliver first.",
        details: { inputRequestId: input.inputRequestId }
      });
    }

    const task = await new CollaborativeTaskService(this.stateStore).getTask(taskId);
    const localIsOwner = task && task.ownerParticipantId === state.localParticipant.participant.id;

    if (localIsOwner) {
      return inputs.answerInputRequest({
        taskId,
        inputRequestId: input.inputRequestId,
        answer: input.answer,
        answeringParticipantId: state.localParticipant.participant.id,
        answerEventId: input.answerEventId ?? mintCollaborativeTaskEventId()
      });
    }

    // Requester → receiver answer over A2A
    const ownerPeer = task ? resolvePeerRecord(state, task.ownerParticipantId) : null;
    if (!ownerPeer) {
      throw createPairMeshError({
        code: "pairmesh.peer_not_found",
        message: "Cannot resolve owner peer to submit InputRequest answer.",
        details: { taskId, inputRequestId: input.inputRequestId }
      });
    }
    const bearerToken = requireOutboundBearer(state, ownerPeer);
    const answerEventId = input.answerEventId ?? mintCollaborativeTaskEventId();
    const wire = await sendPairMeshTaskRequest(
      ownerPeer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: state.session.id,
        operation: "input.answer",
        taskId: CollaborativeTaskIdSchema.parse(taskId),
        inputRequestId: InputRequestIdSchema.parse(input.inputRequestId),
        answer: input.answer,
        answerEventId: CollaborativeTaskEventIdSchema.parse(answerEventId)
      },
      { bearerToken }
    );
    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }
    if (wire.task && wire.inputRequest) {
      await inputs.upsertMirroredDeliver({
        task: wire.task,
        inputRequest: wire.inputRequest
      });
    }
    return {
      task: await new CollaborativeTaskService(this.stateStore).getTask(taskId),
      inputRequest: await inputs.getInputRequest(input.inputRequestId),
      wire
    };
  }

  public async listPendingInputRequests() {
    const inputs = new InputRequestService(this.stateStore);
    const pending = await inputs.listInputRequests({ status: "pending" });
    return pending.map((entry) => inputs.toRequesterView(entry));
  }

  public async getCollaborativeTask(taskId: string) {
    return new CollaborativeTaskService(this.stateStore).getTask(taskId);
  }

  public async getInputRequest(inputRequestId: string) {
    const inputs = new InputRequestService(this.stateStore);
    const row = await inputs.getInputRequest(inputRequestId);
    return row ? inputs.toRequesterView(row) : null;
  }

  public async getLocalParticipantId(): Promise<string> {
    const state = await this.requireActiveSession();
    return state.localParticipant.participant.id;
  }

  /** R5-7 — serialized active session snapshot for Control projections. */
  public async readActiveSessionState(): Promise<LocalSessionState> {
    return this.requireActiveSession();
  }

  /** R5-7 — CollaborativeTask domain service bound to this session store. */
  public getCollaborativeTaskService(): CollaborativeTaskService {
    return new CollaborativeTaskService(this.stateStore);
  }

  /** R5-7 — InputRequest domain service bound to this session store. */
  public getInputRequestService(): InputRequestService {
    return new InputRequestService(this.stateStore);
  }

  /**
   * R5-8-D3 — Heal CollaborativeTasks still blocked_on_action whose linked Action
   * is already terminal (Approve Once completed but observe was missed).
   */
  public async reconcileCollaborativeActionContinuations(): Promise<number> {
    const events = await this.getContinuationOrchestrator().reconcileActionContinuations();
    if (events.length === 0) {
      return 0;
    }
    const providerId = await this.resolveGoalProviderId();
    const workspaceRoot = this.workspaceRoot ?? process.cwd();
    const worker = createGoalTaskWorker({
      providerId,
      workspaceRoot,
      ...(providerId === "fake"
        ? {
            fakeWorker: new FakeTaskWorker({
              instanceId: "reconcile-action-continue",
              script: [
                {
                  kind: "completed",
                  summary: "Continuation after Action reconcile (default Fake)."
                }
              ]
            })
          }
        : {}),
      disableCursorSessionReuse: true
    });
    const orchestrator = this.getContinuationOrchestrator(worker);
    for (const event of events) {
      void orchestrator.continueTask(event.taskId).catch(() => {
        // Leave durable ContinuationEvent for pairmesh task continue.
      });
    }
    return events.length;
  }

  /**
   * Lazy ContinuationOrchestrator bound to ActionService + HostRequestBridge.
   * Caller may swap the worker (e.g. Fake multi-instance tests).
   */
  public getContinuationOrchestrator(
    worker?: import("../collaboration/continuation-orchestrator.js").TaskWorker
  ): ContinuationOrchestrator {
    if (!this.lazyContinuationOrchestrator) {
      const actionService = this.getActionService();
      const bridge = new HostRequestBridge({
        stateStore: this.stateStore,
        actionService
      });
      this.lazyContinuationOrchestrator = new ContinuationOrchestrator({
        stateStore: this.stateStore,
        actionService,
        hostBridge: bridge,
        worker:
          worker ??
          new FakeTaskWorker({
            instanceId: "session-default",
            script: [{ kind: "completed", summary: "Default Fake worker completed." }]
          })
      });
    } else if (worker) {
      this.lazyContinuationOrchestrator.setWorker(worker);
    }
    return this.lazyContinuationOrchestrator;
  }

  /**
   * Owner-local collaborative goal start (receiver path).
   * Creates CollaborativeTask + first provider turn via GoalTaskWorker.
   */
  public async runCollaborativeGoal(input: {
    originalGoal: string;
    providerId?: GoalProviderId;
    requesterParticipantId?: string;
  }): Promise<{
    taskId: string;
    status: string;
    continuationSeq: number;
    turn: DispatchTurnResult;
    presentation: string;
  }> {
    const state = await this.requireActiveSession();
    const ownerId = state.localParticipant.participant.id;
    const requesterId = input.requesterParticipantId ?? state.peers[0]?.participant.id ?? ownerId;
    const tasks = new CollaborativeTaskService(this.stateStore);
    const task = await tasks.createTask({
      sessionId: state.session.id,
      requesterParticipantId: requesterId,
      ownerParticipantId: ownerId,
      originalGoal: input.originalGoal
    });

    const providerId = await this.resolveGoalProviderId(input.providerId);
    const workspaceRoot = this.workspaceRoot ?? process.cwd();
    const worker = createGoalTaskWorker({
      providerId,
      workspaceRoot,
      ...(providerId === "fake"
        ? {
            fakeWorker: new FakeTaskWorker({
              instanceId: `goal-${task.taskId}`,
              onTurn: async () => ({
                kind: "completed" as const,
                summary: "Fake goal worker completed first turn (no scripted host tools)."
              })
            })
          }
        : {}),
      disableCursorSessionReuse: true
    });
    const orchestrator = this.getContinuationOrchestrator(worker);
    const turn = await orchestrator.startTaskTurn(task.taskId);
    const latest = (await tasks.getTask(task.taskId))!;
    return {
      taskId: latest.taskId,
      status: latest.status,
      continuationSeq: latest.continuationSeq,
      turn,
      presentation: `Goal task ${latest.taskId} status=${latest.status}`
    };
  }

  /** Explicit continuation dispatch after InputRequest answer / Action observe. */
  public async continueCollaborativeGoal(taskId: string): Promise<DispatchTurnResult> {
    const orchestrator = this.getContinuationOrchestrator();
    return orchestrator.continueTask(taskId);
  }

  /** Observe a terminal Action and emit ContinuationEvent (idempotent). */
  public async observeCollaborativeActionTerminal(
    execution: import("@pairmesh/protocol").ActionExecutionRecord
  ) {
    return this.getContinuationOrchestrator().observeActionTerminal(execution);
  }

  /**
   * Requester → remote owner: A2A task.goal create+start.
   * Pre-R5 peers without pairmesh.task skill → collaborative_task_unsupported.
   */
  public async startCollaborativeGoalOnPeer(input: {
    peerRef: string;
    originalGoal: string;
    providerId?: GoalProviderId;
  }): Promise<{
    taskId: string;
    status: string;
    continuationSeq?: number;
    pendingInputRequestId?: string;
  }> {
    const prep = await this.mutateSession(async (state) => {
      const peer = resolvePeerRecord(state, input.peerRef);
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Peer not found for collaborative goal.",
          details: { peerRef: input.peerRef }
        });
      }
      return {
        peer,
        bearerToken: requireOutboundBearer(state, peer),
        sessionId: state.session.id
      };
    });

    const wire = await sendPairMeshTaskRequest(
      prep.peer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: prep.sessionId,
        operation: "task.goal",
        originalGoal: input.originalGoal
      },
      { bearerToken: prep.bearerToken }
    );
    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }
    if (wire.task && wire.inputRequest) {
      await new InputRequestService(this.stateStore).upsertMirroredDeliver({
        task: wire.task,
        inputRequest: wire.inputRequest
      });
    }
    return {
      taskId: wire.taskId,
      status: wire.status ?? "working",
      ...(typeof wire.continuationSeq === "number"
        ? { continuationSeq: wire.continuationSeq }
        : {}),
      ...(wire.pendingInputRequestId ? { pendingInputRequestId: wire.pendingInputRequestId } : {})
    };
  }

  /**
   * Requester → remote owner: short task.status hop (≪ ingress abort).
   * Always mirrors safe task (+ linkedAction) locally — R5-R1 CF1.
   */
  public async fetchCollaborativeTaskStatusOnPeer(input: {
    peerRef: string;
    taskId: string;
  }): Promise<{
    taskId: string;
    status: string;
    continuationSeq?: number;
    pendingInputRequestId?: string;
    blockedOnActionId?: string;
    resultSummary?: string;
    failureSummary?: string;
    linkedAction?: import("@pairmesh/protocol").RequesterSafeLinkedAction;
  }> {
    const prep = await this.mutateSession(async (state) => {
      const peer = resolvePeerRecord(state, input.peerRef);
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Peer not found for collaborative task status.",
          details: { peerRef: input.peerRef }
        });
      }
      return {
        peer,
        bearerToken: requireOutboundBearer(state, peer),
        sessionId: state.session.id,
        localParticipantId: state.localParticipant.participant.id
      };
    });

    const wire = await sendPairMeshTaskRequest(
      prep.peer.a2aAgentUrl,
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: prep.sessionId,
        operation: "task.status",
        taskId: CollaborativeTaskIdSchema.parse(input.taskId)
      },
      { bearerToken: prep.bearerToken }
    );
    if (!wire.accepted) {
      throw createPairMeshError(wire.error);
    }

    if (wire.task && wire.inputRequest) {
      await new InputRequestService(this.stateStore).upsertMirroredDeliver({
        task: wire.task,
        inputRequest: wire.inputRequest
      });
    } else if (wire.task) {
      await new InputRequestService(this.stateStore).upsertMirroredTask({
        task: wire.task
      });
    }

    if (wire.linkedAction && wire.task) {
      const { upsertMirroredLinkedAction } =
        await import("../collaboration/requester-action-mirror.js");
      await this.stateStore.mutate((state) => {
        const upserted = upsertMirroredLinkedAction(state, wire.linkedAction!, {
          requesterParticipantId: wire.task!.requesterParticipantId,
          targetParticipantId: wire.task!.ownerParticipantId,
          taskId: wire.task!.taskId
        });
        state.actionExecutions = upserted.state.actionExecutions;
      });
    }

    return {
      taskId: wire.taskId,
      status: wire.status ?? wire.task?.status ?? "working",
      ...(typeof wire.continuationSeq === "number"
        ? { continuationSeq: wire.continuationSeq }
        : {}),
      ...(wire.pendingInputRequestId ? { pendingInputRequestId: wire.pendingInputRequestId } : {}),
      ...(wire.task?.blockedOnActionId ? { blockedOnActionId: wire.task.blockedOnActionId } : {}),
      ...(wire.task?.result?.summary ? { resultSummary: wire.task.result.summary } : {}),
      ...(wire.task?.failure?.message ? { failureSummary: wire.task.failure.message } : {}),
      ...(wire.linkedAction ? { linkedAction: wire.linkedAction } : {})
    };
  }

  /**
   * Poll remote task.status until terminal, waiting_for_input, or waitMs elapses (R5-8-D2 / R5-R1).
   * Continues through blocked_on_action so Approve Once → result can land on the requester.
   * Each hop stays under relay ingress; long provider work lives on the receiver.
   */
  public async waitForCollaborativeGoalOnPeer(input: {
    peerRef: string;
    taskId: string;
    waitMs: number;
    pollIntervalMs?: number;
  }): Promise<{
    taskId: string;
    status: string;
    continuationSeq?: number;
    pendingInputRequestId?: string;
    blockedOnActionId?: string;
    resultSummary?: string;
    failureSummary?: string;
    linkedAction?: import("@pairmesh/protocol").RequesterSafeLinkedAction;
    timedOut: boolean;
  }> {
    const deadline = Date.now() + Math.max(0, input.waitMs);
    const pollIntervalMs = input.pollIntervalMs ?? 1_000;
    const continueStatuses = new Set(["working", "blocked_on_action"]);
    let latest = await this.fetchCollaborativeTaskStatusOnPeer({
      peerRef: input.peerRef,
      taskId: input.taskId
    });
    while (continueStatuses.has(latest.status) && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
      if (Date.now() >= deadline) {
        break;
      }
      latest = await this.fetchCollaborativeTaskStatusOnPeer({
        peerRef: input.peerRef,
        taskId: input.taskId
      });
    }
    return {
      ...latest,
      timedOut: continueStatuses.has(latest.status)
    };
  }

  private async resolveGoalProviderId(override?: GoalProviderId): Promise<GoalProviderId> {
    if (override) {
      return override;
    }
    const workspaceRoot = this.workspaceRoot;
    if (!workspaceRoot) {
      return "fake";
    }
    try {
      const config = await loadConfigFile(configFilePath(workspaceRoot));
      const provider = config.codingAgent?.provider;
      if (
        provider === "claude-code" ||
        provider === "cursor" ||
        provider === "gemini-cli" ||
        provider === "fake"
      ) {
        return provider;
      }
    } catch {
      // fall through
    }
    return "fake";
  }

  /** Lazy ActionService used by Control approve bridge and local receiver APIs. */
  public getActionService(): ActionService {
    if (this.injectedActionService) {
      return this.injectedActionService;
    }
    if (!this.lazyActionService) {
      const workspaceRoot = this.workspaceRoot;
      this.lazyActionService = new ActionService({
        stateFilePath: this.stateStore.stateFilePath,
        onLiveActionPersist: async (execution) => {
          await this.stateStore.update((latest) => {
            return {
              ...latest,
              actionExecutions: [
                ...(latest.actionExecutions ?? []).filter(
                  (entry) => entry.actionId !== execution.actionId
                ),
                execution
              ]
            };
          });
        },
        ...(workspaceRoot
          ? {
              workspaceRoot,
              proposalGenerator: new CodingAgentProposalGenerator(new LazyCodingAgentAdapter()),
              resolveExecutionProviderSnapshot: async () => {
                try {
                  const config = await loadConfigFile(configFilePath(workspaceRoot));
                  const providerId = config.codingAgent?.provider;
                  if (!providerId) return undefined;
                  return buildExecutionProviderSnapshot({ providerId });
                } catch {
                  return undefined;
                }
              },
              loadTestsConfig: async () => {
                try {
                  const config = await loadConfigFile(configFilePath(workspaceRoot));
                  return config.tests;
                } catch {
                  return {
                    maxConcurrent: 1,
                    sessionAllowedProfiles: [],
                    profiles: {}
                  };
                }
              },
              loadProcessConfig: async () => {
                try {
                  const config = await loadConfigFile(configFilePath(workspaceRoot));
                  return (
                    config.processExecution ?? {
                      maxConcurrent: 1,
                      defaultTimeoutMs: 120_000,
                      maxTimeoutMs: 600_000,
                      maxOutputBytes: 262_144,
                      env: {}
                    }
                  );
                } catch {
                  return {
                    maxConcurrent: 1,
                    defaultTimeoutMs: 120_000,
                    maxTimeoutMs: 600_000,
                    maxOutputBytes: 262_144,
                    env: {}
                  };
                }
              }
            }
          : {})
      });
    }
    return this.lazyActionService;
  }

  private emitPermissionDecisionAudit(
    state: LocalSessionState,
    request: PairMeshPermissionRequest,
    decision: PermissionDecisionValue
  ): void {
    const peer = state.peers.find((entry) => entry.participant.id === request.participantId);
    this.emitAudit(
      buildAuditEvent({
        eventType: decision === "deny" ? "permission.denied" : "permission.allowed",
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        target: peer
          ? {
              participantId: peer.participant.id,
              agentId: peer.agent.id,
              peerName: peer.agent.name
            }
          : { participantId: request.participantId },
        correlation: {
          requestId: request.correlationRequestId,
          ...(request.threadId ? { threadId: request.threadId as InspectionThreadId } : {})
        },
        metadata: {
          capabilityId: request.capabilityId,
          permissionRequestId: request.permissionRequestId,
          decision,
          ...(decision === "allow-once"
            ? { scope: "once" as const }
            : decision === "allow-session"
              ? { scope: "session" as const }
              : {})
        }
      })
    );
  }

  private emitActionDecisionAudit(
    state: LocalSessionState,
    execution: import("@pairmesh/protocol").ActionExecutionRecord,
    decision: PermissionDecisionValue
  ): void {
    const eventType =
      execution.status === "denied" || decision === "deny"
        ? ("action.denied" as const)
        : execution.status === "expired"
          ? ("action.failed" as const)
          : execution.status === "completed"
            ? ("action.completed" as const)
            : ("action.approved" as const);
    const peer = state.peers.find(
      (entry) => entry.participant.id === execution.requesterParticipantId
    );
    this.emitAudit(
      buildAuditEvent({
        eventType,
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        target: peer
          ? {
              participantId: peer.participant.id,
              agentId: peer.agent.id,
              peerName: peer.agent.name
            }
          : { participantId: execution.requesterParticipantId },
        correlation: { requestId: execution.actionId },
        metadata: {
          actionId: execution.actionId,
          actionType: execution.actionType,
          capabilityId: execution.capabilityId,
          requesterParticipantId: execution.requesterParticipantId,
          targetParticipantId: execution.targetParticipantId,
          status: execution.status,
          ...(execution.permissionRequestId
            ? { permissionRequestId: execution.permissionRequestId }
            : {}),
          ...(execution.artifactRefs?.[0]
            ? {
                artifactId: execution.artifactRefs[0].artifactId,
                artifactHash: execution.artifactRefs[0].contentHash
              }
            : {})
        }
      })
    );
  }

  public async leaveSession(): Promise<void> {
    const state = await this.stateStore.load();
    if (!state) {
      await clearRelayRoute(relayRouteFileFromStateFile(this.stateStore.stateFilePath));
      throw createPairMeshError({
        code: "pairmesh.session_not_found",
        message: "No local PairMesh session found."
      });
    }

    // Discarding the state discards every credential the session issued, so no
    // bearer or invite can be replayed against a later session on this machine.
    this.emitAudit(
      buildAuditEvent({
        eventType: "session.left",
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        metadata: {}
      })
    );
    await this.stateStore.clear();
    await clearRelayRoute(relayRouteFileFromStateFile(this.stateStore.stateFilePath));
    await getRuntimeRelayBridge()?.stop({ clearPersisted: true, intentional: true });
  }

    public async bindRelayPeerTransport(
    endpoint: string | { peerParticipantId: string; localEndpoint: string }
  ): Promise<void> {
    if (typeof endpoint === "string") {
      const url = endpoint.replace(/\/$/, "");
      const state = await this.stateStore.update((latest) => ({
        ...requireActiveState(latest),
        peers: latest.peers.map((peer) => ({
          ...peer,
          a2aAgentUrl: url,
          connectivity: {
            mode: "relay" as const,
            relayHandle: peer.connectivity?.relayHandle,
            peerTransportPublicKey: peer.connectivity?.peerTransportPublicKey
          }
        }))
      }));
      for (const peer of state.peers) {
        invalidatePeerHealthCache({ peerName: peer.agent.name });
      }
      return;
    }

    const url = endpoint.localEndpoint.replace(/\/$/, "");
    await this.stateStore.update((latest) => ({
      ...requireActiveState(latest),
      peers: latest.peers.map((peer) => {
        if (peer.participant.id !== endpoint.peerParticipantId) {
          return peer;
        }
        return {
          ...peer,
          a2aAgentUrl: url,
          connectivity: {
            mode: "relay" as const,
            relayHandle: peer.connectivity?.relayHandle,
            peerTransportPublicKey: peer.connectivity?.peerTransportPublicKey
          }
        };
      })
    }));
  }

    public async bindRelayPeerTransportForRelayPresence(input: {
    relayParticipantId: string;
    transportPublicKey: string;
    localEndpoint: string;
  }): Promise<void> {
    const run = this.presenceBindQueue.then(() =>
      this.bindRelayPeerTransportForRelayPresenceLocked(input)
    );
    this.presenceBindQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async bindRelayPeerTransportForRelayPresenceLocked(input: {
    relayParticipantId: string;
    transportPublicKey: string;
    localEndpoint: string;
  }): Promise<void> {
    const url = input.localEndpoint.replace(/\/$/, "");
    const pub = input.transportPublicKey.trim().toLowerCase();
    const relayParticipantId = input.relayParticipantId.trim();
    const cardName = await fetchRelayPeerAgentCardName(url);
    let binding: { peer: LocalParticipantRecord; previousUrl: string } | undefined;
    await this.stateStore.update((latest) => {
      requireActiveState(latest);
      const cardMatches = (peer: (typeof latest.peers)[number]): boolean =>
        !cardName || peer.agent.name === cardName;

      let matched = latest.peers.find(
        (peer) => peer.connectivity?.relayPresenceId === relayParticipantId
      );
      if (matched && !cardMatches(matched)) {
        matched = undefined;
      }
      if (!matched) {
        matched = latest.peers.find(
          (peer) =>
            isPairedWithLocal(peer) &&
            peer.connectivity?.peerTransportPublicKey?.toLowerCase() === pub
        );
        if (matched && !cardMatches(matched)) {
          matched = undefined;
        }
      }
      if (!matched && cardName) {
        const byAgent = latest.peers.filter(
          (peer) => isPairedWithLocal(peer) && peer.agent.name === cardName
        );
        if (byAgent.length === 1) {
          matched = byAgent[0];
        }
      }
      if (!matched) {
        // Only safe when exactly one paired peer still lacks a presence binding.
        const candidates = latest.peers.filter(
          (peer) => isPairedWithLocal(peer) && !peer.connectivity?.relayPresenceId
        );
        if (candidates.length === 1 && cardMatches(candidates[0]!)) {
          matched = candidates[0];
        }
      }
      if (!matched) {
        // Single-peer sessions only: remap the sole relay peer after presence churn.
        const paired = latest.peers.filter((peer) => isPairedWithLocal(peer));
        if (paired.length === 1 && cardMatches(paired[0]!)) {
          matched = paired[0];
        }
      }
      if (!matched) {
        return latest;
      }

      const matchedId = matched.participant.id;
      const next: LocalSessionState = {
        ...latest,
        peers: latest.peers.map((peer) => {
          if (peer.participant.id === matchedId) {
            return {
              ...peer,
              a2aAgentUrl: url,
              connectivity: {
                mode: "relay" as const,
                relayPresenceId: relayParticipantId,
                peerTransportPublicKey: pub,
                relayHandle: peer.connectivity?.relayHandle
              }
            };
          }
          // Drop stolen presence / pubkey / duplicate URL so a prior swap cannot stick.
          const samePresence = peer.connectivity?.relayPresenceId === relayParticipantId;
          const sameUrl = peer.a2aAgentUrl.replace(/\/$/, "") === url;
          const samePub = peer.connectivity?.peerTransportPublicKey?.toLowerCase() === pub;
          if (!samePresence && !sameUrl && !samePub) {
            return peer;
          }
          return {
            ...peer,
            connectivity: {
              mode: "relay" as const,
              ...(peer.connectivity?.relayHandle
                ? { relayHandle: peer.connectivity.relayHandle }
                : {})
            }
          };
        })
      };
      binding = { peer: matched, previousUrl: matched.a2aAgentUrl };
      return next;
    });
    if (!binding) {
      return;
    }
    const bound = binding;
    invalidatePeerHealthCache({ peerName: bound.peer.agent.name });
    if (bound.previousUrl && bound.previousUrl.replace(/\/$/, "") !== url) {
      invalidatePeerHealthCache({ a2aAgentUrl: bound.previousUrl });
    }

        const peerName = bound.peer.agent.name;
    const peerUrl = url;
    const bearer = bound.peer.outboundBearer;
    const { getReliabilityTracker } = await import("../reliability/tracker.js");
    const { getRuntimeRelayBridge } = await import("../connectivity/relay-runtime.js");
    const tracker = getReliabilityTracker();
    const bridge = getRuntimeRelayBridge();
    const recoveryCorrelation = bridge?.getRecoveryCorrelationId() ?? undefined;
    tracker.begin("peer.presence_to_ready", {
      transport: "relay",
      replacePrior: true,
      ...(recoveryCorrelation ? { correlationId: recoveryCorrelation } : {})
    });
    void fetchPeerHealth(peerName, peerUrl, { bearerToken: bearer, skipCache: true })
      .then((health) => {
        if (health.reachable) {
          tracker.completeActive("peer.presence_to_ready", {
            outcome: "success",
            phase: "peer_ready"
          });
          if (recoveryCorrelation) {
            tracker.completeActive("recovery.trigger_to_peer_ready", {
              outcome: "success",
              correlationId: recoveryCorrelation,
              reason: bridge?.getLastReconnectReason()
            });
          }
        } else {
          tracker.completeActive("peer.presence_to_ready", {
            outcome: "failed",
            reason: "peer_unreachable"
          });
        }
      })
      .catch(() => {
        tracker.completeActive("peer.presence_to_ready", {
          outcome: "failed",
          reason: "peer_health_error"
        });
      });
  }

  public async sendToPeer(peerRef: string, message: string): Promise<A2ASendResult> {
    const state = await this.requireActiveSession();
    const peer = resolvePeerRecord(state, peerRef);
    if (!peer) {
      throw createPairMeshError({
        code: "pairmesh.peer_not_found",
        message: "Peer not found in the active PairMesh session.",
        details: { peerRef }
      });
    }

    return await sendA2AMessage({
      targetAgentUrl: peer.a2aAgentUrl,
      message,
      pairmeshSessionId: state.session.id,
      bearerToken: requireOutboundBearer(state, peer)
    });
  }

  public async getPeerHealth(peerRef: string): Promise<PeerHealthResult> {
    const state = await this.requireActiveSession();
    const peer = resolvePeerRecord(state, peerRef);
    if (!peer) {
      throw createPairMeshError({
        code: "pairmesh.peer_not_found",
        message: "Peer not found in the active PairMesh session.",
        details: { peerRef }
      });
    }

    return await fetchPeerHealth(peer.agent.name, peer.a2aAgentUrl, {
      bearerToken: peer.outboundBearer
    });
  }

  public async getInspectionStatus(requestId: string): Promise<Record<string, unknown>> {
    const priorStatus = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      return findExecutionRecord(state, requestId)?.status;
    });
    const synced = await syncExecutionFromRemoteTask(requestId, this.stateStore, {
      maxDurationMs: this.inspectionTiming.maxDurationMs,
      quickSync: true
    });
    await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      this.auditSyncedStatusTransition(state, synced.record, priorStatus);
    });
    const peer = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      return state.peers.find((candidate) => candidate.participant.id === synced.record.peerId);
    });
    return buildInspectionStatusView(synced.record, {
      ...(peer ? { safePeer: toSafePeerMeta(peer) } : {})
    });
  }

  public async waitForInspection(
    requestId: string,
    options: WaitForInspectionOptions = {}
  ): Promise<WaitForInspectionResult> {
    const waitMs = clampInspectionWaitMs(options.waitMs, this.inspectionTiming, {
      clampToMcpMax: options.clampToMcpMax
    });
    const started = Date.now();
    let lastTransportUnavailable = false;
    let record = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      const found = findExecutionRecord(state, requestId);
      if (!found) {
        throw createPairMeshError({
          code: "pairmesh.inspection_not_found",
          message: "No inspection execution found for the given request id.",
          details: { requestId }
        });
      }
      return found;
    });

    while (Date.now() - started < waitMs) {
      if (options.signal?.aborted) {
        throw createPairMeshError({
          code: "pairmesh.inspection_cancelled",
          message: "Inspection wait was cancelled."
        });
      }

      const priorStatus = record.status;
      try {
        const synced = await syncExecutionFromRemoteTask(requestId, this.stateStore, {
          maxDurationMs: this.inspectionTiming.maxDurationMs,
          signal: options.signal
        });
        record = synced.record;
        lastTransportUnavailable = false;
      } catch (error) {
        if (
          isPairMeshErrorLike(error) &&
          (error.code === "pairmesh.peer_transport_unavailable" ||
            error.code === "pairmesh.peer_unreachable")
        ) {
          lastTransportUnavailable = true;
          await delay(Math.min(this.inspectionTiming.pollIntervalMs, waitMs), options.signal);
          continue;
        }
        throw error;
      }
      await this.stateStore.enqueue(async () => {
        const state = await this.loadActiveSessionUnchecked();
        this.auditSyncedStatusTransition(state, record, priorStatus);
      });

      if (record.status === "completed" && record.result) {
        const safePeer = await this.stateStore.enqueue(async () => {
          const state = await this.loadActiveSessionUnchecked();
          return this.safePeerFromExecution(state, record);
        });
        return {
          completed: true,
          requestId: record.requestId,
          threadId: record.threadId,
          status: "completed",
          lifecycle: "completed",
          peer: record.peerName,
          ...safePeer,
          ...(record.progressEvents?.length ? { progressEvents: record.progressEvents } : {}),
          result: {
            summary: record.result.summary,
            findings: record.result.findings,
            references: record.result.references ?? []
          }
        };
      }

      if (["failed", "timed_out", "cancelled"].includes(record.status)) {
        const safePeer = await this.stateStore.enqueue(async () => {
          const state = await this.loadActiveSessionUnchecked();
          return this.safePeerFromExecution(state, record);
        });
        const lifecycle: InspectionRequesterLifecycle =
          record.status === "timed_out"
            ? "timed_out"
            : record.status === "cancelled"
              ? "cancelled"
              : "failed";
        return {
          completed: false,
          requestId: record.requestId,
          threadId: record.threadId,
          status: record.status,
          lifecycle,
          peer: record.peerName,
          ...safePeer,
          ...(record.progressEvents?.length ? { progressEvents: record.progressEvents } : {}),
          ...(record.error ? { error: record.error } : {}),
          message: record.message ?? record.error?.message
        };
      }

      await delay(Math.min(this.inspectionTiming.pollIntervalMs, waitMs), options.signal);
    }

    await this.mutateSession((state) => {
      setExecutionLocalWaitState(state, requestId, "expired");
    });
    record = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      return findExecutionRecord(state, requestId)!;
    });
    const peerName = record.peerName;

    // A running execution with no remote task id never reached the peer (e.g.
    // auth failure left a zombie before this fix). Do not tell the client the
    // remote task is "running normally" — that causes endless wait loops.
    if (
      !record.a2aTaskReference?.a2aTaskId &&
      (record.status === "running" || record.status === "pending")
    ) {
      await this.mutateSession((state) => {
        completeExecutionRecord(state, requestId, "failed", {
          code: "pairmesh.internal_error",
          message:
            "Inspection never obtained a remote task from the peer. Retry with pairmesh_ask_peer (do not keep waiting)."
        });
      });
      record = await this.stateStore.enqueue(async () => {
        const state = await this.loadActiveSessionUnchecked();
        return findExecutionRecord(state, requestId)!;
      });
      const safePeer = await this.stateStore.enqueue(async () => {
        const state = await this.loadActiveSessionUnchecked();
        return this.safePeerFromExecution(state, record);
      });
      return {
        completed: false,
        requestId: record.requestId,
        threadId: record.threadId,
        status: "failed",
        lifecycle: "failed",
        peer: peerName,
        ...safePeer,
        ...(record.progressEvents?.length ? { progressEvents: record.progressEvents } : {}),
        ...(record.error ? { error: record.error } : {}),
        message: record.message ?? record.error?.message
      };
    }

    const safePeer = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      return this.safePeerFromExecution(state, record);
    });

    if (lastTransportUnavailable && (record.status === "running" || record.status === "pending")) {
      return {
        completed: false,
        requestId: record.requestId,
        threadId: record.threadId,
        status: record.status === "running" ? "working" : record.status,
        lifecycle: "peer_transport_unavailable",
        peer: peerName,
        ...safePeer,
        ...(record.progressEvents?.length ? { progressEvents: record.progressEvents } : {}),
        error: {
          code: "pairmesh.peer_transport_unavailable",
          message: formatInspectionTransportUnavailableMessage(peerName, record.requestId)
        },
        message: formatInspectionTransportUnavailableMessage(peerName, record.requestId)
      };
    }

    const stillRunning = record.status === "running" || record.status === "pending";
    return {
      completed: false,
      requestId: record.requestId,
      threadId: record.threadId,
      status: record.status === "running" ? "working" : record.status,
      lifecycle: stillRunning ? "requester_wait_expired" : "running",
      peer: peerName,
      ...safePeer,
      ...(record.progressEvents?.length ? { progressEvents: record.progressEvents } : {}),
      message: stillRunning
        ? formatInspectionWaitExpiredMessage(peerName, record.requestId)
        : (record.message ?? formatInspectionStillWorkingMessage(peerName, record.requestId))
    };
  }

  public async cancelInspection(
    requestId: string
  ): Promise<{ requestId: string; cancelled: boolean }> {
    const controller = this.activeOutbound.get(requestId);
    if (controller) {
      controller.abort();
      this.activeOutbound.delete(requestId);
    }

    const cancelMeta = await this.stateStore.enqueue(async () => {
      const state = await this.stateStore.load();
      if (!state) {
        return null;
      }
      const record = findExecutionRecord(state, requestId);
      if (!record) {
        return { priorStatus: undefined as InspectionExecutionRecord["status"] | undefined };
      }
      const peerUrl = record.peerAgentUrl ?? record.a2aTaskReference?.agent?.a2aAgentCardUrl;
      const bearerToken = state.peers.find(
        (peer) => peer.participant.id === record.peerId
      )?.outboundBearer;
      return {
        priorStatus: record.status,
        a2aTaskId: record.a2aTaskReference?.a2aTaskId,
        peerUrl,
        bearerToken
      };
    });

    if (cancelMeta?.a2aTaskId && cancelMeta.peerUrl) {
      try {
        await cancelPairMeshInspectionTask(
          cancelMeta.peerUrl,
          cancelMeta.a2aTaskId,
          cancelMeta.bearerToken
        );
      } catch {
        // Best-effort remote cancellation.
      }
    }

    if (cancelMeta) {
      await this.mutateSession((state) => {
        completeExecutionRecord(state, requestId, "cancelled", {
          code: "pairmesh.inspection_cancelled",
          message: "Inspection was cancelled."
        });
        const cancelled = findExecutionRecord(state, requestId);
        if (cancelled && cancelMeta.priorStatus !== "cancelled") {
          this.auditSyncedStatusTransition(state, cancelled, cancelMeta.priorStatus);
        }
      });
    }

    return { requestId, cancelled: controller !== undefined || cancelMeta !== null };
  }

  public async askPeer(peerRef: string, question: string): Promise<PeerInspectionResult> {
    this.assertRelayTransportAllowsInspection();

    const prep = await this.mutateSession(async (state) => {
      const peer = resolvePeerRecord(state, peerRef);
      if (!peer) {
        throw createPairMeshError({
          code: "pairmesh.peer_not_found",
          message: "Peer not found in the active PairMesh session.",
          details: { peerRef }
        });
      }
      assertPairedForAsk(state, peer);

      const approvalResume = findResumableApprovalRequiredExecution(state, {
        peerId: peer.participant.id,
        question
      });
      if (approvalResume) {
        return {
          kind: "approval_resume" as const,
          peer,
          threadId: approvalResume.threadId,
          turnNumber: approvalResume.turnNumber,
          reuseRequestId: approvalResume.requestId
        };
      }

      const duplicate = findRecentDuplicateExecution(state, {
        peerId: peer.participant.id,
        question,
        windowMs: this.inspectionTiming.duplicateQuestionWindowMs
      });
      if (duplicate) {
        return { kind: "duplicate" as const, peer, duplicate };
      }

      const threadRecord = createInitiatorThreadRecord({
        state,
        targetPeerName: peerRef.trim(),
        targetPeerId: peer.participant.id,
        topic: question.slice(0, 200)
      });
      state.inspectionThreads.push(threadRecord);
      return {
        kind: "new" as const,
        peer,
        threadId: threadRecord.thread.id
      };
    });

    if (prep.kind === "duplicate") {
      const state = await this.requireActiveSession();
      return this.reuseDuplicateInspectionResult(state, prep.peer, prep.duplicate);
    }

    if (prep.kind === "approval_resume") {
      return await this.executeInspectionTurn(
        prep.threadId,
        prep.peer,
        question,
        prep.turnNumber,
        undefined,
        prep.reuseRequestId
      );
    }

    return await this.executeInspectionTurn(prep.threadId, prep.peer, question, 1);
  }

  public async followUpInspection(
    threadId: InspectionThreadId,
    question: string,
    options?: { peerRef?: string }
  ): Promise<PeerInspectionResult> {
    this.assertRelayTransportAllowsInspection();
    const state = await this.requireActiveSession();
    const threadRecord = requireInitiatorThread(state, threadId);
    const peer = state.peers.find(
      (candidate) => candidate.participant.id === threadRecord.thread.targetPeerId
    );
    if (!peer) {
      throw createPairMeshError({
        code: "pairmesh.peer_not_found",
        message: "Inspection thread target peer is no longer in the active session.",
        details: { threadId }
      });
    }
    // Follow-ups route by stored participant id only. Optional peerRef must match.
    if (options?.peerRef?.trim()) {
      const resolved = resolvePeerRecord(state, options.peerRef);
      if (!resolved || resolved.participant.id !== peer.participant.id) {
        throw createPairMeshError({
          code: "pairmesh.invalid_metadata",
          message: "Follow-up peer selector does not match the thread's stored participant id.",
          details: {
            threadId,
            threadParticipantId: peer.participant.id,
            peerRef: options.peerRef.trim()
          }
        });
      }
    }
    assertPairedForAsk(state, peer);

    const turnNumber = threadRecord.turns.length + 1;
    const duplicate = findRecentDuplicateExecution(state, {
      peerId: peer.participant.id,
      question,
      threadId: threadRecord.thread.id,
      windowMs: this.inspectionTiming.duplicateQuestionWindowMs
    });
    if (duplicate) {
      return this.reuseDuplicateInspectionResult(state, peer, duplicate);
    }

    return await this.executeInspectionTurn(threadRecord.thread.id, peer, question, turnNumber);
  }

  public async retryInspection(
    threadId: InspectionThreadId,
    retryOfRequestId: string
  ): Promise<PeerInspectionResult> {
    const state = await this.requireActiveSession();
    const priorExecution = findExecutionRecord(state, retryOfRequestId);
    if (!priorExecution) {
      throw createPairMeshError({
        code: "pairmesh.inspection_not_found",
        message: "Cannot retry: prior inspection execution was not found.",
        details: { retryOfRequestId }
      });
    }

    if (priorExecution.status === "completed") {
      throw createPairMeshError({
        code: "pairmesh.inspection_thread_invalid_state",
        message: "Cannot retry a completed inspection. Use the existing result or ask a follow-up.",
        details: { retryOfRequestId }
      });
    }

    if (!["timed_out", "failed", "cancelled"].includes(priorExecution.status)) {
      throw createPairMeshError({
        code: "pairmesh.inspection_thread_invalid_state",
        message: "Cannot retry an inspection that is still running.",
        details: { retryOfRequestId, status: priorExecution.status }
      });
    }

    const threadRecord = requireInitiatorThread(state, threadId);
    const peer = state.peers.find(
      (candidate) => candidate.participant.id === threadRecord.thread.targetPeerId
    );
    if (!peer) {
      throw createPairMeshError({
        code: "pairmesh.peer_not_found",
        message: "Inspection thread target peer is no longer in the active session.",
        details: { threadId }
      });
    }

    return await this.executeInspectionTurn(
      threadRecord.thread.id,
      peer,
      priorExecution.question,
      priorExecution.turnNumber,
      retryOfRequestId
    );
  }

  public async listInspectionThreads(peerFilter?: string): Promise<InspectionThreadSummary[]> {
    const state = await this.requireActiveSession();
    return listInspectionThreads(state, peerFilter).map((record) => ({
      id: record.thread.id,
      peer: record.targetPeerName,
      status: record.thread.status,
      turnCount: record.turns.length,
      createdAt: record.thread.createdAt,
      updatedAt: record.thread.updatedAt,
      ...(record.thread.topic ? { topic: record.thread.topic } : {})
    }));
  }

  public async getInspectionThread(threadId: InspectionThreadId): Promise<InspectionThreadDetail> {
    const state = await this.requireActiveSession();
    const record = requireInitiatorThread(state, threadId);
    return {
      id: record.thread.id,
      peer: record.targetPeerName,
      status: record.thread.status,
      createdAt: record.thread.createdAt,
      updatedAt: record.thread.updatedAt,
      ...(record.thread.topic ? { topic: record.thread.topic } : {}),
      turns: record.turns.map((turn) => ({
        requestId: turn.turn.requestId,
        question: turn.turn.question,
        createdAt: turn.turn.createdAt,
        ...(turn.result
          ? {
              summary: turn.result.summary,
              findings: turn.result.findings,
              references: turn.result.references ?? []
            }
          : {})
      }))
    };
  }

  public async closeInspectionThread(threadId: InspectionThreadId): Promise<void> {
    await this.mutateSession((state) => {
      const record = requireInitiatorThread(state, threadId);
      closeThreadRecord(record);
    });
  }

  private async executeInspectionTurn(
    threadId: InspectionThreadId,
    peer: LocalParticipantRecord,
    question: string,
    turnNumber: number,
    retryOfRequestId?: string,
    reuseRequestId?: string
  ): Promise<PeerInspectionResult> {
    const prep = await this.mutateSession(async (state) => {
      const threadRecord = requireInitiatorThread(state, threadId);
      // Fail fast when this pairing has no credential rather than after the peer
      // rejects the authenticated call.
      requireOutboundBearer(state, peer);
      const request = buildInspectionRequest(
        state.session.id,
        threadId,
        question,
        turnNumber,
        reuseRequestId
      );

      this.emitAudit(
        buildAuditEvent({
          eventType: "inspection.requested",
          projectId: state.localParticipant.agent.projectId,
          sessionId: state.session.id,
          sessionCode: state.sessionCode,
          actor: {
            participantId: state.localParticipant.participant.id,
            agentId: state.localParticipant.agent.id,
            peerName: state.localParticipant.agent.name
          },
          target: {
            participantId: peer.participant.id,
            agentId: peer.agent.id,
            peerName: peer.agent.name
          },
          correlation: { requestId: request.requestId, threadId },
          metadata: { direction: "outbound" }
        })
      );

      const existing = findExecutionRecord(state, request.requestId);
      if (existing) {
        if (existing.status === "completed" && existing.result) {
          return {
            action: "completed" as const,
            request,
            targetPeerName: threadRecord.targetPeerName,
            result: existing.result
          };
        }
        if (existing.status === "running" || existing.status === "pending") {
          return {
            action: "finish_existing" as const,
            request,
            targetPeerName: threadRecord.targetPeerName,
            requestId: existing.requestId
          };
        }
        // Resume after approval_required (or other terminal) with the same requestId.
        if (
          reuseRequestId &&
          (existing.status === "failed" ||
            existing.status === "timed_out" ||
            existing.status === "cancelled")
        ) {
          const resumedBase = {
            ...existing,
            status: "pending" as const,
            phase: "accepted" as const,
            message: "Resuming after local peer approval.",
            updatedAt: IsoUtcTimestampSchema.parse(new Date().toISOString())
          };
          const rest = { ...resumedBase };
          delete rest.completedAt;
          delete rest.error;
          delete rest.a2aTaskReference;
          delete rest.localWaitState;
          delete rest.remoteTaskState;
          delete rest.result;
          delete rest.executionStartedAt;
          upsertExecutionRecord(state, InspectionExecutionRecordSchema.parse(rest));
          return {
            action: "finish_existing" as const,
            request,
            targetPeerName: threadRecord.targetPeerName,
            requestId: request.requestId
          };
        }
      }

      const execution = createExecutionRecord({
        threadId,
        peerId: peer.participant.id,
        peerName: threadRecord.targetPeerName,
        turnNumber,
        question,
        requestId: request.requestId,
        peerAgentUrl: peer.a2aAgentUrl,
        retryOfRequestId
      });
      upsertExecutionRecord(state, execution);
      return {
        action: "new" as const,
        request,
        targetPeerName: threadRecord.targetPeerName,
        requestId: request.requestId
      };
    });

    if (prep.action === "completed") {
      return this.toCompletedInspectionResult(peer, prep.targetPeerName, prep.request, prep.result);
    }

    if (!this.skipPeerHealthPreflight) {
      const health = await fetchPeerHealth(peer.agent.name, peer.a2aAgentUrl, {
        bearerToken: peer.outboundBearer
      });
      await this.mutateSession((state) => {
        updateExecutionProgress(state, prep.requestId, {
          phase: health.reachable ? "peer-reachable" : "failed",
          message: health.reachable
            ? `${peer.agent.name}'s PairMesh agent is reachable.`
            : `${peer.agent.name}'s PairMesh agent is unreachable.`
        });
      });
      assertPeerReadyForInspection(peer.agent.name, health);
    }

    return await this.finishInteractiveInspection(
      threadId,
      prep.request,
      peer,
      prep.targetPeerName,
      prep.requestId
    );
  }

  private async finishInteractiveInspection(
    threadId: InspectionThreadId,
    request: ReturnType<typeof buildInspectionRequest>,
    peer: LocalParticipantRecord,
    targetPeerName: string,
    requestId: string
  ): Promise<PeerInspectionResult> {
    const bearerToken = await this.stateStore.enqueue(async () => {
      const state = await this.loadActiveSessionUnchecked();
      return requireOutboundBearer(state, peer);
    });

    await this.mutateSession((state) => {
      updateExecutionProgress(state, requestId, {
        phase: "inspecting",
        message: `${peer.agent.name}'s coding agent is inspecting...`
      });
      setExecutionLocalWaitState(state, requestId, "waiting");
    });

    const outbound = new AbortController();
    this.activeOutbound.set(requestId, outbound);

    let elapsedTimer: NodeJS.Timeout | undefined;
    elapsedTimer = setInterval(() => {
      void this.mutateSession((state) => {
        const current = findExecutionRecord(state, requestId);
        if (!current || (current.status !== "running" && current.status !== "pending")) {
          return;
        }
        const clockStart = current.executionStartedAt ?? current.startedAt;
        updateExecutionProgress(state, requestId, {
          phase: "inspecting",
          message: `Still inspecting — ${Math.round((Date.now() - Date.parse(clockStart)) / 1000)} seconds elapsed.`,
          elapsedMs: Date.now() - Date.parse(clockStart)
        });
      });
    }, 5_000);

    try {
      const existingTaskId = await this.stateStore.enqueue(async () => {
        const state = await this.loadActiveSessionUnchecked();
        const existingRecord = findExecutionRecord(state, requestId);
        return existingRecord?.a2aTaskReference?.a2aTaskId;
      });

      if (existingTaskId) {
        const polled = await waitForPairMeshInspectionTask(peer.a2aAgentUrl, existingTaskId, {
          signal: outbound.signal,
          timeoutMs: this.inspectionTiming.interactiveWaitMs,
          pollIntervalMs: this.inspectionTiming.pollIntervalMs,
          bearerToken
        });
        if (polled.response?.accepted) {
          await applySuccessfulRemoteResponse(requestId, polled.response, this.stateStore);
          const completed = await this.stateStore.enqueue(async () => {
            const state = await this.loadActiveSessionUnchecked();
            const record = findExecutionRecord(state, requestId);
            if (!record?.result) {
              return undefined;
            }
            this.auditInspectionSuccess(state, peer, request, record);
            return record.result;
          });
          if (completed) {
            return this.toCompletedInspectionResult(peer, targetPeerName, request, completed);
          }
        } else if (polled.response && !polled.response.accepted) {
          const approval = await this.toApprovalRequiredResult(
            threadId,
            targetPeerName,
            request,
            peer,
            polled.response.error
          );
          if (approval) {
            return approval;
          }
          throw polled.response.error;
        } else {
          await this.mutateSession((state) => {
            setExecutionLocalWaitState(state, requestId, "expired");
          });
          return {
            completed: false,
            status: "working",
            threadId,
            peer: targetPeerName,
            safePeer: toSafePeerMeta(peer),
            requestId,
            question: request.question,
            message: formatInspectionWorkingMessage(peer.agent.name, requestId)
          };
        }
      }

      const interactive = await runPairMeshInspectionInteractive(peer.a2aAgentUrl, request, {
        signal: outbound.signal,
        timeoutMs: this.inspectionTiming.interactiveWaitMs,
        bearerToken
      });

      await this.mutateSession((state) => {
        attachA2ATaskReference(
          state,
          requestId,
          interactive.a2aTaskId,
          peer.a2aAgentUrl,
          interactive.remoteTaskState
        );
      });

      if (interactive.completed && interactive.response?.accepted) {
        await applySuccessfulRemoteResponse(requestId, interactive.response, this.stateStore);
        const completed = await this.stateStore.enqueue(async () => {
          const state = await this.loadActiveSessionUnchecked();
          const record = findExecutionRecord(state, requestId);
          if (!record?.result) {
            return undefined;
          }
          this.auditInspectionSuccess(state, peer, request, record);
          return record.result;
        });
        if (completed) {
          return this.toCompletedInspectionResult(peer, targetPeerName, request, completed);
        }
      }

      if (interactive.response && !interactive.response.accepted) {
        const approval = await this.toApprovalRequiredResult(
          threadId,
          targetPeerName,
          request,
          peer,
          interactive.response.error
        );
        if (approval) {
          return approval;
        }
        throw interactive.response.error;
      }

      await this.mutateSession((state) => {
        setExecutionLocalWaitState(state, requestId, "expired");
      });

      return {
        completed: false,
        status: "working",
        threadId,
        peer: targetPeerName,
        safePeer: toSafePeerMeta(peer),
        requestId,
        question: request.question,
        message: formatInspectionWorkingMessage(peer.agent.name, requestId)
      };
    } catch (error) {
      if (isPairMeshErrorLike(error)) {
        const pmError = error;
        await this.mutateSession((state) => {
          if (pmError.code === "pairmesh.inspection_timeout") {
            completeExecutionRecord(state, requestId, "timed_out", {
              code: pmError.code,
              message: pmError.message
            });
            this.auditInspectionTerminal(
              state,
              peer,
              request,
              "inspection.timed_out",
              pmError.code
            );
          } else if (pmError.code === "pairmesh.inspection_cancelled") {
            completeExecutionRecord(state, requestId, "cancelled", {
              code: pmError.code,
              message: pmError.message
            });
            this.auditInspectionTerminal(
              state,
              peer,
              request,
              "inspection.cancelled",
              pmError.code
            );
          } else if (
            pmError.code === "pairmesh.peer_unreachable" ||
            pmError.code === "pairmesh.coding_agent_unavailable" ||
            pmError.code === "pairmesh.authentication_required" ||
            pmError.code === "pairmesh.authentication_failed" ||
            pmError.code === "pairmesh.peer_revoked" ||
            pmError.code === "pairmesh.capability_denied"
          ) {
            // Terminal auth/reachability failures must not leave a "running"
            // zombie — retries would otherwise reuse it as "still working".
            completeExecutionRecord(state, requestId, "failed", {
              code: pmError.code,
              message: pmError.message
            });
            this.auditInspectionTerminal(state, peer, request, "inspection.failed", pmError.code);
            if (
              pmError.code === "pairmesh.authentication_required" ||
              pmError.code === "pairmesh.authentication_failed" ||
              pmError.code === "pairmesh.peer_revoked"
            ) {
              this.emitAudit(
                buildAuditEvent({
                  eventType: "authentication.failed",
                  projectId: state.localParticipant.agent.projectId,
                  sessionId: state.session.id,
                  sessionCode: state.sessionCode,
                  actor: {
                    participantId: state.localParticipant.participant.id,
                    agentId: state.localParticipant.agent.id,
                    peerName: state.localParticipant.agent.name
                  },
                  target: {
                    participantId: peer.participant.id,
                    agentId: peer.agent.id,
                    peerName: peer.agent.name
                  },
                  correlation: { requestId, threadId: request.threadId },
                  metadata: {
                    reason: mapAuthFailureReason(pmError.code),
                    skill: "pairmesh.inspect"
                  }
                })
              );
            }
          }
        });
      }
      throw error;
    } finally {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
      }
      this.activeOutbound.delete(requestId);
    }
  }

  private toCompletedInspectionResult(
    peer: LocalParticipantRecord,
    peerName: string,
    request: ReturnType<typeof buildInspectionRequest>,
    result: NonNullable<InspectionExecutionRecord["result"]>
  ): PeerInspectionCompletedResult {
    return {
      completed: true,
      threadId: request.threadId,
      peer: peerName,
      safePeer: toSafePeerMeta(peer),
      requestId: request.requestId,
      question: request.question,
      summary: result.summary,
      findings: result.findings,
      references: result.references ?? []
    };
  }

  private async toApprovalRequiredResult(
    threadId: InspectionThreadId,
    targetPeerName: string,
    request: ReturnType<typeof buildInspectionRequest>,
    peer: LocalParticipantRecord,
    error: PairMeshError
  ): Promise<PeerInspectionApprovalRequiredResult | undefined> {
    if (error.code !== "pairmesh.approval_required") {
      return undefined;
    }

    const details =
      error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    const permissionRequestId =
      typeof details.permissionRequestId === "string"
        ? details.permissionRequestId
        : "perm_unknown";
    const capability =
      typeof details.capability === "string" ? details.capability : "repository.inspect";

    await this.mutateSession((state) => {
      completeExecutionRecord(state, request.requestId, "failed", {
        code: error.code,
        message: error.message
      });
      // Approval wait is not ACP execution — clear any premature deadline clock/task ref.
      const failed = findExecutionRecord(state, request.requestId);
      if (failed) {
        const cleared = { ...failed };
        delete cleared.executionStartedAt;
        delete cleared.a2aTaskReference;
        delete cleared.remoteTaskState;
        upsertExecutionRecord(state, InspectionExecutionRecordSchema.parse(cleared));
      }
      this.auditInspectionTerminal(state, peer, request, "inspection.failed", error.code);
    });

    return {
      completed: false,
      status: "approval_required",
      threadId,
      peer: targetPeerName,
      safePeer: toSafePeerMeta(peer),
      requestId: request.requestId,
      question: request.question,
      permissionRequestId,
      capability,
      message:
        error.message ||
        `${peer.agent.name} must approve ${capability} before this request can run. Do not re-pair or run PairMesh setup — wait for local approval, then ask again with the same question to resume this requestId.`
    };
  }

  private async reuseDuplicateInspectionResult(
    state: LocalSessionState,
    peer: LocalParticipantRecord,
    duplicate: InspectionExecutionRecord
  ): Promise<PeerInspectionResult> {
    const threadRecord = requireInitiatorThread(state, duplicate.threadId);

    if (duplicate.status === "completed" && duplicate.result) {
      return {
        completed: true,
        threadId: duplicate.threadId,
        peer: threadRecord.targetPeerName,
        safePeer: toSafePeerMeta(peer),
        requestId: duplicate.requestId,
        question: duplicate.question,
        summary: duplicate.result.summary,
        findings: duplicate.result.findings,
        references: duplicate.result.references ?? []
      };
    }

    if (duplicate.status === "running" || duplicate.status === "pending") {
      return {
        completed: false,
        status: "working",
        threadId: duplicate.threadId,
        peer: threadRecord.targetPeerName,
        safePeer: toSafePeerMeta(peer),
        requestId: duplicate.requestId,
        question: duplicate.question,
        message: formatInspectionDuplicateWorkingMessage(peer.agent.name, duplicate.requestId)
      };
    }

    return await this.executeInspectionTurn(
      duplicate.threadId,
      peer,
      duplicate.question,
      duplicate.turnNumber
    );
  }

  private emitAudit(event: PairMeshAuditEvent): void {
    this.auditLog.record(event);
  }

  private auditInspectionSuccess(
    state: LocalSessionState,
    peer: LocalParticipantRecord,
    request: ReturnType<typeof buildInspectionRequest>,
    record: InspectionExecutionRecord
  ): void {
    const startedMs = Date.parse(record.startedAt);
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : undefined;
    this.auditInspectionTerminal(
      state,
      peer,
      request,
      "inspection.completed",
      undefined,
      durationMs
    );
    this.emitAudit(
      buildAuditEvent({
        eventType: "inspection.result_shared",
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: peer.participant.id,
          agentId: peer.agent.id,
          peerName: peer.agent.name
        },
        target: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        correlation: { requestId: request.requestId, threadId: request.threadId },
        metadata: buildResultSharedMetadata({
          direction: "inbound",
          summary: record.result?.summary,
          findings: record.result?.findings,
          references: record.result?.references
        })
      })
    );
  }

  private auditInspectionTerminal(
    state: LocalSessionState,
    peer: LocalParticipantRecord,
    request: ReturnType<typeof buildInspectionRequest>,
    eventType:
      | "inspection.completed"
      | "inspection.failed"
      | "inspection.cancelled"
      | "inspection.timed_out",
    errorCode?: string,
    durationMs?: number
  ): void {
    this.emitAudit(
      buildAuditEvent({
        eventType,
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        target: {
          participantId: peer.participant.id,
          agentId: peer.agent.id,
          peerName: peer.agent.name
        },
        correlation: { requestId: request.requestId, threadId: request.threadId },
        metadata: {
          direction: "outbound",
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(errorCode ? { errorCode } : {})
        }
      })
    );
  }

  /**
   * Emit initiator-side audit when status/wait sync observes a new terminal state
   * (cancel, hard timeout, or completed result retrieved after local wait expiry).
   */
  private auditSyncedStatusTransition(
    state: LocalSessionState,
    record: InspectionExecutionRecord,
    priorStatus: InspectionExecutionRecord["status"] | undefined
  ): void {
    if (!priorStatus || priorStatus === record.status) {
      return;
    }
    const peer = state.peers.find((entry) => entry.participant.id === record.peerId);
    if (!peer) {
      return;
    }
    const request = {
      requestId: record.requestId,
      threadId: record.threadId
    } as ReturnType<typeof buildInspectionRequest>;
    const startedMs = Date.parse(record.startedAt);
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : undefined;

    if (record.status === "completed" && record.result) {
      this.auditInspectionSuccess(state, peer, request, record);
      return;
    }
    if (record.status === "timed_out") {
      this.auditInspectionTerminal(
        state,
        peer,
        request,
        "inspection.timed_out",
        record.error?.code ?? "pairmesh.inspection_timeout",
        durationMs
      );
      return;
    }
    if (record.status === "cancelled") {
      this.auditInspectionTerminal(
        state,
        peer,
        request,
        "inspection.cancelled",
        record.error?.code ?? "pairmesh.inspection_cancelled",
        durationMs
      );
      return;
    }
    if (record.status === "failed") {
      this.auditInspectionTerminal(
        state,
        peer,
        request,
        "inspection.failed",
        record.error?.code,
        durationMs
      );
    }
  }

  private async requireActiveSession(): Promise<LocalSessionState> {
    return this.stateStore.enqueue(async () => {
      return await this.loadActiveSessionUnchecked();
    });
  }

  /** Serialized load → mutate → save. Never call across network/ACP waits. */
  private async mutateSession<T>(
    mutator: (state: LocalSessionState) => Promise<T> | T
  ): Promise<T> {
    return this.stateStore.mutate(mutator);
  }

  private async loadActiveSessionUnchecked(): Promise<LocalSessionState> {
    const state = await this.stateStore.load();
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

  private assertRelayTransportAllowsInspection(): void {
    const bridge = getRuntimeRelayBridge();
    if (!bridge) {
      return;
    }
    const status = bridge.getStatus();
    if (status.lifecycle === "ready" && status.connected) {
      return;
    }
    if (status.lifecycle === "idle" || status.lifecycle === "stopped") {
      // No active relay path — direct/overlay or not yet started; peer health decides.
      return;
    }
    if (
      status.lifecycle === "reconnecting" ||
      status.lifecycle === "offline" ||
      status.lifecycle === "connecting" ||
      status.lifecycle === "e2e_negotiating" ||
      status.lifecycle === "connected"
    ) {
      throw createPairMeshError({
        code: "pairmesh.connectivity_reconnecting",
        message:
          "PairMesh is reconnecting the relay transport. Wait for peer ready, then retry the same ask — do not re-pair.",
        details: {
          lifecycle: status.lifecycle,
          ...(typeof status.reconnectAttempt === "number"
            ? { reconnectAttempt: status.reconnectAttempt }
            : {})
        }
      });
    }
    if (status.lifecycle === "auth_failed") {
      throw createPairMeshError({
        code: "pairmesh.relay_authentication_failed",
        message:
          "Relay authentication failed. Check connectivity.relayUrl and session route credentials — this is not a Stage 8 peer permission error.",
        details: { lifecycle: status.lifecycle }
      });
    }
  }

  private buildLocalParticipantRecord(options: {
    session: PairMeshSession;
    identity: ReturnType<typeof createLocalPairMeshIdentity>;
    agentUrl: string;
    isLocal: boolean;
    serviceLabel?: string;
  }): LocalParticipantRecord {
    const participant = PairMeshSessionParticipantSchema.parse({
      id: PeerIdSchema.parse(`peer_${randomUUID()}`),
      sessionId: options.session.id,
      developerId: options.identity.developer.id,
      agentId: options.identity.agent.id,
      joinedAt: nowUtc()
    });

    return {
      participant,
      agent: options.identity.agent,
      developer: options.identity.developer,
      device: options.identity.device,
      a2aAgentUrl: options.agentUrl,
      isLocal: options.isLocal,
      ...(options.serviceLabel ? { serviceLabel: options.serviceLabel } : {})
    };
  }

  private safePeerFromExecution(
    state: LocalSessionState,
    record: InspectionExecutionRecord
  ): { safePeer?: SafePeerMeta } {
    const peer = state.peers.find((candidate) => candidate.participant.id === record.peerId);
    return peer ? { safePeer: toSafePeerMeta(peer) } : {};
  }

  private toStatusView(state: LocalSessionState): SessionStatusView {
    return {
      sessionCode: state.sessionCode,
      sessionId: state.session.id,
      status: state.session.status,
      createdAt: state.session.createdAt,
      localParticipant: state.localParticipant,
      peers: state.peers,
      security: describeSessionSecurity(state)
    };
  }
}

async function fetchRelayPeerAgentCardName(localEndpoint: string): Promise<string | undefined> {
  try {
    const cardRes = await fetch(`${localEndpoint.replace(/\/$/, "")}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(8_000)
    });
    if (!cardRes.ok) {
      return undefined;
    }
    const card = (await cardRes.json()) as { name?: string };
    const name = card.name?.trim();
    return name && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export function parseInviteSecret(value: string): PairMeshInviteSecret {
  const parsed = PairMeshInviteSecretSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw createPairMeshError({
      code: "pairmesh.invite_invalid",
      message:
        "Invalid PairMesh invite secret. Use the exact `--invite` value from the creator's join command."
    });
  }
  return parsed.data;
}

export function parseSessionCode(value: string): SessionCode {
  const parsed = SessionCodeSchema.safeParse(value.trim().toUpperCase());
  if (!parsed.success) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Invalid PairMesh session code.",
      details: { sessionCode: value }
    });
  }
  return parsed.data;
}

export function resolvePeerRecord(
  state: LocalSessionState,
  peerRef: string
): LocalParticipantRecord | undefined {
  try {
    return resolvePeerTarget(state, peerRef).peer;
  } catch (error) {
    if (isPairMeshErrorLike(error) && error.code === "pairmesh.peer_not_found") {
      return undefined;
    }
    throw error;
  }
}

function nowUtc(): string {
  return IsoUtcTimestampSchema.parse(new Date().toISOString());
}

function isPairMeshErrorLike(error: unknown): error is PairMeshError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as PairMeshError).code === "string" &&
    (error as PairMeshError).code.startsWith("pairmesh.") &&
    "message" in error &&
    typeof (error as PairMeshError).message === "string"
  );
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      clearTimeout(timer);
      reject(
        createPairMeshError({
          code: "pairmesh.inspection_cancelled",
          message: "Inspection was cancelled."
        })
      );
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          createPairMeshError({
            code: "pairmesh.inspection_cancelled",
            message: "Inspection was cancelled."
          })
        );
      },
      { once: true }
    );
  });
}
