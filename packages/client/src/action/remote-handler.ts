import {
  PAIRMESH_METADATA_VERSION,
  PairMeshActionWireFailureResponseSchema,
  PairMeshActionWireSuccessResponseSchema,
  PairMeshErrorSchema,
  createPairMeshError,
  type ActionExecutionRecord,
  type ActionId,
  type PairMeshActionWireRequest,
  type PairMeshActionWireResponse,
  type PairMeshActionWireSuccessResponse,
  type PairMeshError,
  type PeerId
} from "@pairmesh/protocol";
import type { LocalSessionState } from "../session/schemas.js";
import type { LocalStateStore } from "../state/store.js";
import type { ActionService } from "./service.js";

const ABSOLUTE_PATH_PATTERN = /^(\/|~\/|[a-zA-Z]:\\)/;

const FORBIDDEN_OUTPUT_KEY_PATTERN =
  /^(executableabsolute|cwdabsolute|env|path|controltoken|control_token)$/i;

/** Relay ingress aborts local A2A fetch at 3s — keep wire ack well under that. */
export const ACTION_WIRE_ACK_BUDGET_MS = 2_000;

/** Prefer returning a terminal wire view when provider finishes this quickly. */
const ACTION_WIRE_FAST_COMPLETE_MS = 750;

export interface ProcessPairMeshActionWireOptions {
  stateStore: LocalStateStore;
  actionService: ActionService;
  /** Authenticated requester peer id from the inbound A2A session. */
  participantId: PeerId;
}

export async function processPairMeshActionWireRequest(
  request: PairMeshActionWireRequest,
  options: ProcessPairMeshActionWireOptions
): Promise<PairMeshActionWireResponse> {
  const { stateStore, actionService, participantId } = options;

  if (request.operation === "request") {
    return processActionRequestWire(request, options);
  }

  return stateStore.enqueue(async () => {
    const state = await stateStore.load();
    if (!state || state.session.status !== "active") {
      return failureResponse(request.actionId, {
        code: "pairmesh.session_not_found",
        message: "No active PairMesh session on receiving agent."
      });
    }

    if (request.sessionId !== state.session.id) {
      return failureResponse(request.actionId, {
        code: "pairmesh.session_invalid_state",
        message: "Action request session does not match active PairMesh session."
      });
    }

    if (!participantId) {
      return failureResponse(request.actionId, {
        code: "pairmesh.authentication_required",
        message: "Authenticated participant identity is required for controlled actions."
      });
    }

    const paired = state.peers.some((peer) => peer.participant.id === participantId);
    if (!paired) {
      return failureResponse(request.actionId, {
        code: "pairmesh.authentication_required",
        message: "Requester is not a paired participant in this session."
      });
    }

    const localName =
      state.localParticipant.developer?.displayName?.trim() ||
      state.localParticipant.agent?.name?.trim() ||
      undefined;

    try {
      if (request.operation === "status") {
        const execution = actionService.findExecution(state, request.actionId);
        if (!execution) {
          return failureResponse(request.actionId, {
            code: "pairmesh.action_not_found",
            message: "Action execution not found."
          });
        }
        if (execution.requesterParticipantId !== participantId) {
          return failureResponse(request.actionId, {
            code: "pairmesh.action_not_authorized",
            message: "Only the original requester may read this action status."
          });
        }
        return toWireActionView(execution, localName);
      }

      // cancel
      const existing = actionService.findExecution(state, request.actionId);
      if (!existing) {
        return failureResponse(request.actionId, {
          code: "pairmesh.action_not_found",
          message: "Action execution not found."
        });
      }
      if (existing.requesterParticipantId !== participantId) {
        return failureResponse(request.actionId, {
          code: "pairmesh.action_not_authorized",
          message: "Only the original requester may cancel this action."
        });
      }
      const cancelled = actionService.cancelAction(state, request.actionId);
      await stateStore.writeExclusive(cancelled.state);
      return toWireActionView(cancelled.execution, localName);
    } catch (error) {
      const pairMeshError = asPairMeshError(error);
      if (pairMeshError) {
        return failureResponse(request.actionId, pairMeshError);
      }
      return failureResponse(request.actionId, {
        code: "pairmesh.internal_error",
        message: "Controlled action request failed due to an unexpected local error."
      });
    }
  });
}

async function processActionRequestWire(
  request: PairMeshActionWireRequest,
  options: ProcessPairMeshActionWireOptions
): Promise<PairMeshActionWireResponse> {
  const { stateStore, actionService, participantId } = options;

  type Begun = {
    response: PairMeshActionWireResponse;
    localName?: string;
    resume?: () => Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }>;
  };

  let begun: Begun;
  try {
    begun = await stateStore.enqueue(async () => {
      const state = await stateStore.load();
      if (!state || state.session.status !== "active") {
        return {
          response: failureResponse(request.actionId, {
            code: "pairmesh.session_not_found",
            message: "No active PairMesh session on receiving agent."
          })
        };
      }

      if (request.sessionId !== state.session.id) {
        return {
          response: failureResponse(request.actionId, {
            code: "pairmesh.session_invalid_state",
            message: "Action request session does not match active PairMesh session."
          })
        };
      }

      if (!participantId) {
        return {
          response: failureResponse(request.actionId, {
            code: "pairmesh.authentication_required",
            message: "Authenticated participant identity is required for controlled actions."
          })
        };
      }

      const paired = state.peers.some((peer) => peer.participant.id === participantId);
      if (!paired) {
        return {
          response: failureResponse(request.actionId, {
            code: "pairmesh.authentication_required",
            message: "Requester is not a paired participant in this session."
          })
        };
      }

      const localName =
        state.localParticipant.developer?.displayName?.trim() ||
        state.localParticipant.agent?.name?.trim() ||
        undefined;

      const accepted = await actionService.beginRequestAction(state, {
        actionId: request.actionId,
        requesterParticipantId: participantId,
        targetParticipantId: state.localParticipant.participant.id,
        actionType: request.actionType!,
        parameters: request.parameters,
        artifactRef: request.artifactRef
      });
      await stateStore.writeExclusive(accepted.state);
      return {
        response: toWireActionView(accepted.execution, localName),
        localName,
        resume: accepted.resume
      };
    });
  } catch (error) {
    const pairMeshError = asPairMeshError(error);
    if (pairMeshError) {
      return failureResponse(request.actionId, pairMeshError);
    }
    return failureResponse(request.actionId, {
      code: "pairmesh.internal_error",
      message: "Controlled action request failed due to an unexpected local error."
    });
  }

  if (begun.resume) {
    const resumePromise = begun.resume();
    const raced = await Promise.race([
      resumePromise.then((result) => ({ kind: "done" as const, result })),
      delay(ACTION_WIRE_FAST_COMPLETE_MS).then(() => ({ kind: "pending" as const }))
    ]);

    if (raced.kind === "done") {
      await stateStore.enqueue(async () => {
        const current = await stateStore.load();
        if (!current) {
          return;
        }
        await stateStore.writeExclusive(
          mergeActionTerminalState(current, raced.result.state, raced.result.execution)
        );
      });
      return toWireActionView(raced.result.execution, begun.localName);
    }

    void resumePromise
      .then(async (final) => {
        await stateStore.enqueue(async () => {
          const current = await stateStore.load();
          if (!current) {
            return;
          }
          await stateStore.writeExclusive(
            mergeActionTerminalState(current, final.state, final.execution)
          );
        });
      })
      .catch(() => {
        // Background provider failure is persisted via ActionService live hooks when possible.
      });
  }

  return begun.response;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeActionTerminalState(
  current: LocalSessionState,
  resultState: LocalSessionState,
  execution: ActionExecutionRecord
): LocalSessionState {
  const artifacts = [...(current.actionArtifacts ?? [])];
  for (const artifact of resultState.actionArtifacts ?? []) {
    if (!artifacts.some((entry) => entry.artifactId === artifact.artifactId)) {
      artifacts.push(artifact);
    }
  }
  return {
    ...current,
    actionExecutions: [
      ...(current.actionExecutions ?? []).filter((entry) => entry.actionId !== execution.actionId),
      execution
    ],
    actionArtifacts: artifacts
  };
}

export function toWireActionView(
  execution: ActionExecutionRecord,
  localPeerName?: string
): PairMeshActionWireSuccessResponse {
  const summary = execution.result?.summary;
  const message = approvalWaitingMessage(execution, localPeerName);
  const artifactRefs = execution.result?.artifactRefs ?? execution.artifactRefs;
  const outputs = sanitizeActionOutputs(execution.result?.outputs);
  const error = execution.result?.error ?? execution.error;

  return PairMeshActionWireSuccessResponseSchema.parse({
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: true,
    actionId: execution.actionId,
    status: execution.status,
    summary,
    message,
    permissionRequestId: execution.permissionRequestId,
    capabilityId: execution.capabilityId,
    actionType: execution.actionType,
    requesterParticipantId: execution.requesterParticipantId,
    targetParticipantId: execution.targetParticipantId,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    executionStartedAt: execution.executionStartedAt,
    completedAt: execution.completedAt ?? execution.result?.completedAt,
    approvalExpiresAt: execution.approvalBinding?.expiresAt,
    artifactRefs,
    outputs,
    error,
    executorInvocationCount: execution.executorInvocationCount
  });
}

function approvalWaitingMessage(
  execution: ActionExecutionRecord,
  localPeerName?: string
): string | undefined {
  if (execution.status !== "approval_required") {
    return undefined;
  }
  const name = localPeerName?.trim();
  switch (execution.actionType) {
    case "repository.edit":
      return name
        ? `Waiting for ${name} to approve this exact proposal.`
        : "Waiting for approval of this exact proposal.";
    case "tests.run":
      return "Waiting for approval of this exact test profile.";
    case "process.execute":
      return "Waiting for approval of this exact command.";
    case "change.propose":
      return name
        ? `Waiting for ${name} to approve this exact proposal.`
        : "Waiting for approval of this exact proposal.";
    default:
      return name
        ? `Waiting for ${name} to approve this action.`
        : "Waiting for approval of this action.";
  }
}

function sanitizeActionOutputs(
  outputs: Record<string, string | number | boolean | null> | undefined
): PairMeshActionWireSuccessResponse["outputs"] {
  if (!outputs) {
    return undefined;
  }
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(outputs)) {
    if (FORBIDDEN_OUTPUT_KEY_PATTERN.test(key)) {
      continue;
    }
    if (typeof value === "string" && ABSOLUTE_PATH_PATTERN.test(value)) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function failureResponse(actionId: ActionId, error: PairMeshError): PairMeshActionWireResponse {
  return PairMeshActionWireFailureResponseSchema.parse({
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: false,
    actionId,
    error: createPairMeshError(error)
  });
}

function asPairMeshError(error: unknown): PairMeshError | undefined {
  const parsed = PairMeshErrorSchema.safeParse(error);
  return parsed.success ? parsed.data : undefined;
}
