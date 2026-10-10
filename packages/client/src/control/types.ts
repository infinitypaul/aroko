import type {
  CapabilityGrantPolicy,
  PairMeshAuditEvent,
  PairMeshPermissionRequest,
  PermissionDecisionValue
} from "@pairmesh/protocol";
import type { PeerRelationshipStatus } from "../session/relationship.js";
import type { PeerConnectivityStatus } from "../session/peer-view.js";

/** Safe control status snapshot — never includes credentials or invite hashes. */
export interface ControlStatusView {
  version: string;
  buildId?: string;
  buildTimestamp?: string;
    controlApiSchemaVersion?: number;
  projectId?: string;
  workspace?: string;
  runtime: {
    running: boolean;
    controlUrl?: string;
    a2aBaseUrl?: string;
    advertisedUrl?: string;
    bindHost?: string;
    agentName?: string;
    mode?: string;
    /** True when no in-flight PairMesh inspect/action work. */
    idle?: boolean;
    busyReasons?: string[];
  };
  session: {
    present: boolean;
    sessionCode?: string;
    sessionId?: string;
    status?: string;
    authenticated: boolean;
    localAgent?: string;
    peerCount: number;
  };
  codingAgent?: {
    provider: string;
    status?: string;
  };
  /** Pending package upgrade restart (survives CLI exit). */
  deferredRestart?: {
    pending: boolean;
    targetBuildId?: string;
  };
    reliability?: {
    lastReconnect?: { durationMs: number; reason?: string };
    lastPeerRecovery?: { durationMs: number; reason?: string };
    lastUpgrade?: { durationMs: number };
    lastRequestDelivery?: { durationMs: number };
    lastPresenceReady?: { durationMs: number };
  };
}

export interface ControlPeerView {
  peer: string;
  participantId: string;
  displayName: string;
  service?: string;
  relationship: PeerRelationshipStatus;
  connectivity?: PeerConnectivityStatus;
  /** Coding-agent readiness — separate from verified-route connection status. */
  agent?: "ready" | "unavailable" | "unknown";
  agentUrl?: string;
  health?: { reachable: boolean; readyForInspection?: boolean; status?: string };
  grants: Array<{ capabilityId: string; policy: CapabilityGrantPolicy; updatedAt: string }>;
}

export interface ControlPermissionsView {
  peers: ControlPeerView[];
  pending: Array<{
    permissionRequestId: string;
    participantId: string;
    peerName?: string;
    displayName?: string;
    service?: string;
    capabilityId: string;
    correlationRequestId: string;
    threadId?: string;
    actionType?: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }>;
}

export interface ControlCapabilityDefinitionView {
  id: string;
  risk: string;
  description: string;
  defaultPolicy: CapabilityGrantPolicy;
}

export interface ControlInviteResult {
  sessionCode: string;
  inviteSecret: string;
  expiresAt: string;
  joinCommand: string;
  peerUrl: string;
  initialGrants: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>;
}

export interface ControlJoinInput {
  sessionCode?: string;
  peerUrl?: string;
  inviteSecret?: string;
  /** Full `aroko join ...` command string. */
  joinCommand?: string;
  name?: string;
  agentUrl?: string;
}

export type { PairMeshAuditEvent, PairMeshPermissionRequest, PermissionDecisionValue };
