import { AuditLog, buildAuditEvent, buildResultSharedMetadata } from "@pairmesh/client";
import type { LocalStateStore } from "@pairmesh/client";
import type {
  AuditAuthFailureReason,
  PairMeshInspectionRequest,
  PairMeshInspectionResponse
} from "@pairmesh/protocol";

export async function recordReceiverAuthFailure(
  stateStore: LocalStateStore,
  input: {
    reason: AuditAuthFailureReason;
    skill?: string;
    participantId?: string;
    request?: PairMeshInspectionRequest;
  }
): Promise<void> {
  const audit = AuditLog.fromStateFile(stateStore.stateFilePath);
  try {
    const state = await stateStore.load();
    audit.record(
      buildAuditEvent({
        eventType: "authentication.failed",
        projectId: state?.localParticipant.agent.projectId,
        sessionId: state?.session.id,
        sessionCode: state?.sessionCode,
        actor: state
          ? {
              participantId: state.localParticipant.participant.id,
              agentId: state.localParticipant.agent.id,
              peerName: state.localParticipant.agent.name
            }
          : undefined,
        target: input.participantId ? { participantId: input.participantId } : undefined,
        correlation: input.request
          ? { requestId: input.request.requestId, threadId: input.request.threadId }
          : undefined,
        metadata: {
          reason: input.reason,
          ...(input.skill ? { skill: input.skill } : {})
        }
      })
    );
  } catch {
    // Never fail the request path for audit I/O.
  }
}

export async function recordReceiverInspectionLifecycle(
  stateStore: LocalStateStore,
  input: {
    eventType:
      | "inspection.started"
      | "inspection.completed"
      | "inspection.failed"
      | "inspection.result_shared";
    participantId: string;
    request: PairMeshInspectionRequest;
    response?: PairMeshInspectionResponse;
    errorCode?: string;
    durationMs?: number;
  }
): Promise<void> {
  const audit = AuditLog.fromStateFile(stateStore.stateFilePath);
  try {
    const state = await stateStore.load();
    if (!state) {
      return;
    }
    const peer = state.peers.find((entry) => entry.participant.id === input.participantId);
    const local = state.localParticipant;

    if (input.eventType === "inspection.result_shared" && input.response?.accepted) {
      audit.record(
        buildAuditEvent({
          eventType: "inspection.result_shared",
          projectId: local.agent.projectId,
          sessionId: state.session.id,
          sessionCode: state.sessionCode,
          actor: {
            participantId: local.participant.id,
            agentId: local.agent.id,
            peerName: local.agent.name
          },
          target: peer
            ? {
                participantId: peer.participant.id,
                agentId: peer.agent.id,
                peerName: peer.agent.name
              }
            : { participantId: input.participantId },
          correlation: {
            requestId: input.request.requestId,
            threadId: input.request.threadId
          },
          metadata: buildResultSharedMetadata({
            direction: "outbound",
            summary: input.response.summary,
            findings: input.response.findings,
            references: input.response.references
          })
        })
      );
      return;
    }

    if (input.eventType === "inspection.result_shared") {
      return;
    }

    audit.record(
      buildAuditEvent({
        eventType: input.eventType,
        projectId: local.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: peer
          ? {
              participantId: peer.participant.id,
              agentId: peer.agent.id,
              peerName: peer.agent.name
            }
          : { participantId: input.participantId },
        target: {
          participantId: local.participant.id,
          agentId: local.agent.id,
          peerName: local.agent.name
        },
        correlation: {
          requestId: input.request.requestId,
          threadId: input.request.threadId
        },
        metadata: {
          direction: "inbound",
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {})
        }
      })
    );
  } catch {
    // Never fail the request path for audit I/O.
  }
}

export async function recordReceiverCapabilityDecision(
  stateStore: LocalStateStore,
  input: {
    eventType: "permission.requested" | "permission.allowed" | "permission.denied";
    participantId: string;
    request: PairMeshInspectionRequest;
    capabilityId: string;
    permissionRequestId?: string;
    decision?: "allow-once" | "allow-session" | "deny";
  }
): Promise<void> {
  const audit = AuditLog.fromStateFile(stateStore.stateFilePath);
  try {
    const state = await stateStore.load();
    if (!state) {
      return;
    }
    const peer = state.peers.find((entry) => entry.participant.id === input.participantId);
    const local = state.localParticipant;
    audit.record(
      buildAuditEvent({
        eventType: input.eventType,
        projectId: local.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: local.participant.id,
          agentId: local.agent.id,
          peerName: local.agent.name
        },
        target: peer
          ? {
              participantId: peer.participant.id,
              agentId: peer.agent.id,
              peerName: peer.agent.name
            }
          : { participantId: input.participantId },
        correlation: {
          requestId: input.request.requestId,
          threadId: input.request.threadId
        },
        metadata: {
          capabilityId: input.capabilityId,
          ...(input.permissionRequestId ? { permissionRequestId: input.permissionRequestId } : {}),
          ...(input.decision ? { decision: input.decision } : {})
        }
      })
    );
    await audit.flush();
  } catch {
    // Never fail the request path for audit I/O.
  }
}
