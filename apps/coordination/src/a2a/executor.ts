import { type Message, Role, TaskState, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import {
  ActionService,
  CodingAgentProposalGenerator,
  LazyCodingAgentAdapter,
  authorizeInspection,
  cancelReceiverInspection,
  configFilePath,
  encodePairMeshActionResponse,
  encodePairMeshInspectionResponse,
  encodePairMeshInspectProgress,
  encodePairMeshJoinResponse,
  encodePairMeshTaskResponse,
  ensureDefaultGrants,
  extractTextFromMessage,
  loadConfigFile,
  markPermissionAudited,
  mayIncludeSourceReferences,
  parsePairMeshPayloadFromMessage,
  processPairMeshActionWireRequest,
  processPairMeshInspectionRequest,
  processPairMeshJoinRequest,
  processPairMeshTaskWireRequest,
  LocalStateStore,
  type CodingAgentAdapter
} from "@pairmesh/client";
import {
  MAX_INSPECT_PROGRESS_WIRE_EVENTS,
  PAIRMESH_METADATA_VERSION,
  PairMeshInspectionFailureResponseSchema,
  CollaborativeTaskIdSchema,
  createPairMeshError,
  latestProgressSequence,
  projectInspectionProgressForRequester,
  type PairMeshErrorCode,
  type PairMeshInspectionRequest,
  type PairMeshInspectionResponse,
  type PairMeshJoinResponse,
  type PeerId,
  type ProgressEvent
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TaskOwnershipRegistry } from "./auth.js";
import {
  recordReceiverAuthFailure,
  recordReceiverCapabilityDecision,
  recordReceiverInspectionLifecycle
} from "./audit-hooks.js";

const taskRequestIds = new Map<string, string>();

function buildAgentTextResponse(
  requestContext: RequestContext,
  text: string,
  mediaType: string
): Message {
  return {
    messageId: randomUUID(),
    contextId: requestContext.contextId,
    taskId: requestContext.taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType
      }
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

export class PairMeshAgentExecutor implements AgentExecutor {
  private readonly stateStore: LocalStateStore;
  private readonly codingAgentAdapter: CodingAgentAdapter;
  private readonly taskOwnership: TaskOwnershipRegistry;
  private lazyActionService?: ActionService;
  private readonly injectedActionService?: ActionService;

  public constructor(
    stateStore?: LocalStateStore,
    codingAgentAdapter?: CodingAgentAdapter,
    taskOwnership?: TaskOwnershipRegistry,
    actionService?: ActionService
  ) {
    this.stateStore = stateStore ?? new LocalStateStore();
    this.codingAgentAdapter = codingAgentAdapter ?? new LazyCodingAgentAdapter();
    this.taskOwnership = taskOwnership ?? new TaskOwnershipRegistry();
    this.injectedActionService = actionService;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const envelope = parsePairMeshPayloadFromMessage(requestContext.userMessage);

    if (envelope?.type === "pairmesh.join.request") {
      // Join is authorized by the single-use invite secret in the payload, not
      // by a bearer: the joiner has no credential until this call succeeds.
      const response = await processPairMeshJoinRequest(this.stateStore, envelope.payload);
      eventBus.publish(
        AgentEvent.message(buildPairMeshJoinAgentResponse(requestContext, response))
      );
      eventBus.finished();
      return;
    }

    if (envelope?.type === "pairmesh.action.request") {
      const participantId = requestContext.context.user?.isAuthenticated
        ? requestContext.context.user.userName
        : undefined;

      if (!participantId) {
        void recordReceiverAuthFailure(this.stateStore, {
          reason: "missing_credential",
          skill: "pairmesh.action"
        });
        const failure = {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          accepted: false as const,
          actionId: envelope.payload.actionId,
          error: createPairMeshError({
            code: "pairmesh.authentication_required",
            message:
              "Controlled actions require a PairMesh session credential. Re-pair with a fresh invite."
          })
        };
        eventBus.publish(
          AgentEvent.message(buildPairMeshActionAgentResponse(requestContext, failure))
        );
        eventBus.finished();
        return;
      }

      const authorized = await this.isAuthorizedParticipant(participantId);
      if (!authorized) {
        void recordReceiverAuthFailure(this.stateStore, {
          reason: "revoked_credential",
          skill: "pairmesh.action",
          participantId
        });
        const failure = {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          accepted: false as const,
          actionId: envelope.payload.actionId,
          error: createPairMeshError({
            code: "pairmesh.peer_revoked",
            message: "This PairMesh session credential is no longer valid for the active session."
          })
        };
        eventBus.publish(
          AgentEvent.message(buildPairMeshActionAgentResponse(requestContext, failure))
        );
        eventBus.finished();
        return;
      }

      const response = await processPairMeshActionWireRequest(envelope.payload, {
        stateStore: this.stateStore,
        actionService: this.getActionService(),
        participantId: participantId as PeerId
      });
      eventBus.publish(
        AgentEvent.message(buildPairMeshActionAgentResponse(requestContext, response))
      );
      eventBus.finished();
      return;
    }

    if (envelope?.type === "pairmesh.task.request") {
      const participantId = requestContext.context.user?.isAuthenticated
        ? requestContext.context.user.userName
        : undefined;

      const wireTaskId =
        envelope.payload.taskId ?? CollaborativeTaskIdSchema.parse(`task_${randomUUID()}`);

      if (!participantId) {
        void recordReceiverAuthFailure(this.stateStore, {
          reason: "missing_credential",
          skill: "pairmesh.task"
        });
        const failure = {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          accepted: false as const,
          taskId: wireTaskId,
          error: createPairMeshError({
            code: "pairmesh.authentication_required",
            message:
              "Collaborative task operations require a PairMesh session credential. Re-pair with a fresh invite."
          })
        };
        eventBus.publish(
          AgentEvent.message(buildPairMeshTaskAgentResponse(requestContext, failure))
        );
        eventBus.finished();
        return;
      }

      const authorized = await this.isAuthorizedParticipant(participantId);
      if (!authorized) {
        void recordReceiverAuthFailure(this.stateStore, {
          reason: "revoked_credential",
          skill: "pairmesh.task",
          participantId
        });
        const failure = {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          accepted: false as const,
          taskId: wireTaskId,
          error: createPairMeshError({
            code: "pairmesh.peer_revoked",
            message: "This PairMesh session credential is no longer valid for the active session."
          })
        };
        eventBus.publish(
          AgentEvent.message(buildPairMeshTaskAgentResponse(requestContext, failure))
        );
        eventBus.finished();
        return;
      }

      const workspace =
        process.env.PAIRMESH_WORKSPACE?.trim() || process.env.PWD?.trim() || process.cwd();
      const response = await processPairMeshTaskWireRequest(envelope.payload, {
        stateStore: this.stateStore,
        participantId: participantId as PeerId,
        actionService: this.getActionService(),
        workspaceRoot: workspace
      });
      eventBus.publish(
        AgentEvent.message(buildPairMeshTaskAgentResponse(requestContext, response))
      );
      eventBus.finished();
      return;
    }

    if (envelope?.type === "pairmesh.inspect.request") {
      const participantId = requestContext.context.user?.isAuthenticated
        ? requestContext.context.user.userName
        : undefined;

      if (!participantId) {
        void recordReceiverAuthFailure(this.stateStore, {
          reason: "missing_credential",
          skill: "pairmesh.inspect",
          request: envelope.payload
        });
        this.publishInspectionRejection(
          requestContext,
          eventBus,
          envelope.payload,
          "pairmesh.authentication_required",
          "Inspection requires a PairMesh session credential. Re-pair with a fresh invite."
        );
        return;
      }

      const authorized = await this.isAuthorizedParticipant(participantId);
      if (!authorized) {
        void recordReceiverAuthFailure(this.stateStore, {
          reason: "revoked_credential",
          skill: "pairmesh.inspect",
          participantId,
          request: envelope.payload
        });
        this.publishInspectionRejection(
          requestContext,
          eventBus,
          envelope.payload,
          "pairmesh.peer_revoked",
          "This PairMesh session credential is no longer valid for the active session."
        );
        return;
      }

      // Idempotent replay of a completed request must not re-enter approval or
      // consume allow_once again — handler returns the cached turn.
      const cached = await this.hasCachedInspectionResult(envelope.payload);
      if (!cached) {
        const capabilityGate = await this.authorizeCapability(
          participantId as PeerId,
          envelope.payload
        );
        if (capabilityGate.kind === "denied") {
          if (!capabilityGate.alreadyAudited) {
            await recordReceiverCapabilityDecision(this.stateStore, {
              eventType: "permission.denied",
              participantId,
              request: envelope.payload,
              capabilityId: "repository.inspect",
              decision: "deny",
              ...(capabilityGate.permissionRequestId
                ? { permissionRequestId: capabilityGate.permissionRequestId }
                : {})
            });
            if (capabilityGate.permissionRequestId) {
              await this.stateStore.update((latest) =>
                markPermissionAudited(latest, capabilityGate.permissionRequestId!, "denied")
              );
            }
          }
          this.publishInspectionRejection(
            requestContext,
            eventBus,
            envelope.payload,
            "pairmesh.capability_denied",
            capabilityGate.message
          );
          return;
        }
        if (capabilityGate.kind === "approval_required") {
          if (capabilityGate.created) {
            await recordReceiverCapabilityDecision(this.stateStore, {
              eventType: "permission.requested",
              participantId,
              request: envelope.payload,
              capabilityId: "repository.inspect",
              permissionRequestId: capabilityGate.permissionRequestId
            });
            await this.stateStore.update((latest) =>
              markPermissionAudited(latest, capabilityGate.permissionRequestId, "requested")
            );
          }
          this.publishInspectionRejection(
            requestContext,
            eventBus,
            envelope.payload,
            "pairmesh.approval_required",
            `${capabilityGate.localPeerName} must approve repository inspection before this request can run. Do not re-pair or run PairMesh setup.`,
            {
              status: "approval_required",
              permissionRequestId: capabilityGate.permissionRequestId,
              capability: "repository.inspect",
              requestId: envelope.payload.requestId
            }
          );
          return;
        }
      }

      const requestId = envelope.payload.requestId;
      taskRequestIds.set(requestContext.taskId, requestId);
      this.taskOwnership.claim(requestContext.taskId, participantId);

      eventBus.publish(AgentEvent.task(buildInitialWorkingTask(requestContext)));
      void recordReceiverInspectionLifecycle(this.stateStore, {
        eventType: "inspection.started",
        participantId,
        request: envelope.payload
      });

      const startedAt = Date.now();
      let lastPublishedSequence = -1;
      let lastPublishAt = 0;
      const publishRequesterProgress = (events: readonly ProgressEvent[]): void => {
        const projected = projectInspectionProgressForRequester(events, {
          maxEvents: MAX_INSPECT_PROGRESS_WIRE_EVENTS
        });
        const latestSequence = latestProgressSequence(events);
        if (latestSequence <= lastPublishedSequence && projected.length === 0) {
          return;
        }
        const now = Date.now();
        // Bound publish rate while still allowing first rich event promptly.
        if (
          latestSequence > 0 &&
          now - lastPublishAt < 250 &&
          latestSequence === lastPublishedSequence
        ) {
          return;
        }
        lastPublishedSequence = Math.max(lastPublishedSequence, latestSequence);
        lastPublishAt = now;
        const progressMessage = {
          ...encodePairMeshInspectProgress({
            metadataVersion: PAIRMESH_METADATA_VERSION,
            requestId,
            latestSequence: Math.max(0, latestSequence),
            events: projected
          }),
          contextId: requestContext.contextId,
          taskId: requestContext.taskId,
          role: Role.ROLE_AGENT
        };
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: progressMessage,
              timestamp: new Date().toISOString()
            },
            metadata: { pairmeshRequestId: requestId }
          })
        );
      };

      try {
        const response = await processPairMeshInspectionRequest(
          envelope.payload,
          this.codingAgentAdapter,
          this.stateStore,
          {
            participantId,
            onProgressPersisted: publishRequesterProgress
          }
        );

        const durationMs = Math.max(0, Date.now() - startedAt);
        if (response.accepted) {
          void recordReceiverInspectionLifecycle(this.stateStore, {
            eventType: "inspection.completed",
            participantId,
            request: envelope.payload,
            response,
            durationMs
          });
          void recordReceiverInspectionLifecycle(this.stateStore, {
            eventType: "inspection.result_shared",
            participantId,
            request: envelope.payload,
            response,
            durationMs
          });
        } else {
          void recordReceiverInspectionLifecycle(this.stateStore, {
            eventType: "inspection.failed",
            participantId,
            request: envelope.payload,
            response,
            errorCode: response.error.code,
            durationMs
          });
        }

        const agentMessage = buildPairMeshInspectionAgentResponse(requestContext, response);
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            status: {
              state: response.accepted
                ? TaskState.TASK_STATE_COMPLETED
                : TaskState.TASK_STATE_FAILED,
              message: agentMessage,
              timestamp: new Date().toISOString()
            },
            metadata: { pairmeshRequestId: requestId }
          })
        );
      } finally {
        taskRequestIds.delete(requestContext.taskId);
        eventBus.finished();
      }
      return;
    }

    const inputText = extractTextFromMessage(requestContext.userMessage);
    eventBus.publish(
      AgentEvent.message(
        buildAgentTextResponse(requestContext, `PairMesh peer received: ${inputText}`, "text/plain")
      )
    );
    eventBus.finished();
  }

  /** Confirms the credential still maps to a peer in the active session. */
  private async isAuthorizedParticipant(participantId: string): Promise<boolean> {
    try {
      const state = await this.stateStore.load();
      return (
        state?.session.status === "active" &&
        state.peers.some((peer) => peer.participant.id === participantId)
      );
    } catch {
      return false;
    }
  }

  private getActionService(): ActionService {
    if (this.injectedActionService) {
      return this.injectedActionService;
    }
    if (!this.lazyActionService) {
      const workspace =
        process.env.PAIRMESH_WORKSPACE?.trim() ||
        join(process.cwd(), "fixtures", "payment-workspace");
      this.lazyActionService = new ActionService({
        stateFilePath: this.stateStore.stateFilePath,
        workspaceRoot: workspace,
        proposalGenerator: new CodingAgentProposalGenerator(this.codingAgentAdapter),
        loadTestsConfig: async () => {
          try {
            const config = await loadConfigFile(configFilePath(workspace));
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
            const config = await loadConfigFile(configFilePath(workspace));
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
      });
    }
    return this.lazyActionService;
  }

  private async hasCachedInspectionResult(request: PairMeshInspectionRequest): Promise<boolean> {
    try {
      const state = await this.stateStore.load();
      if (!state) {
        return false;
      }
      const thread = state.inspectionThreads.find((entry) => entry.thread.id === request.threadId);
      return Boolean(
        thread?.turns.some(
          (turn) => turn.turn.requestId === request.requestId && turn.result !== undefined
        )
      );
    } catch {
      return false;
    }
  }

  private async authorizeCapability(
    participantId: PeerId,
    request: PairMeshInspectionRequest
  ): Promise<
    | { kind: "allowed"; includeSourceReferences: boolean }
    | {
        kind: "denied";
        message: string;
        alreadyAudited: boolean;
        permissionRequestId?: string;
      }
    | {
        kind: "approval_required";
        permissionRequestId: string;
        localPeerName: string;
        created: boolean;
      }
  > {
    let outcome!: ReturnType<typeof authorizeInspection>["outcome"];
    const authorizedState = await this.stateStore.update((latest) => {
      if (!latest.sessionSecurity) {
        throw createPairMeshError({
          code: "pairmesh.session_requires_repair",
          message: "No active PairMesh session authorization state."
        });
      }
      const nextState = {
        ...latest,
        sessionSecurity: ensureDefaultGrants(latest.sessionSecurity, participantId),
        permissionRequests: latest.permissionRequests ?? []
      };
      const authorized = authorizeInspection(nextState, {
        participantId,
        correlationRequestId: request.requestId,
        threadId: request.threadId
      });
      outcome = authorized.outcome;
      return authorized.state;
    });

    if (outcome.status === "denied") {
      return {
        kind: "denied",
        message: outcome.message,
        alreadyAudited: outcome.alreadyAudited,
        ...(outcome.permissionRequestId ? { permissionRequestId: outcome.permissionRequestId } : {})
      };
    }
    if (outcome.status === "approval_required") {
      return {
        kind: "approval_required",
        permissionRequestId: outcome.permissionRequest.permissionRequestId,
        localPeerName: authorizedState.localParticipant.agent.name,
        created: outcome.created
      };
    }

    return {
      kind: "allowed",
      includeSourceReferences: mayIncludeSourceReferences(authorizedState, participantId)
    };
  }

  private publishInspectionRejection(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
    request: PairMeshInspectionRequest,
    code: PairMeshErrorCode,
    message: string,
    details?: Record<string, string>
  ): void {
    const response = PairMeshInspectionFailureResponseSchema.parse({
      metadataVersion: PAIRMESH_METADATA_VERSION,
      accepted: false,
      requestId: request.requestId,
      error: createPairMeshError({
        code,
        message,
        ...(details ? { details } : {})
      })
    });

    eventBus.publish(AgentEvent.task(buildInitialWorkingTask(requestContext)));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        status: {
          state: TaskState.TASK_STATE_REJECTED,
          message: buildPairMeshInspectionAgentResponse(requestContext, response),
          timestamp: new Date().toISOString()
        },
        metadata: { pairmeshRequestId: request.requestId }
      })
    );
    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const requestId = taskRequestIds.get(taskId);
    if (requestId) {
      cancelReceiverInspection(requestId);
    }

    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: requestId ? { pairmeshRequestId: requestId } : {}
      })
    );
    taskRequestIds.delete(taskId);
  }
}

function buildInitialWorkingTask(requestContext: RequestContext): Task {
  const userMessage = requestContext.userMessage;
  const priorHistory = requestContext.task?.history ?? [];
  const history = priorHistory.length > 0 ? priorHistory : userMessage ? [userMessage] : [];

  return {
    id: requestContext.taskId,
    contextId: requestContext.contextId,
    status: {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history,
    metadata: {}
  };
}

function buildPairMeshJoinAgentResponse(
  requestContext: RequestContext,
  response: PairMeshJoinResponse
): Message {
  const encoded = encodePairMeshJoinResponse(response);
  return {
    ...encoded,
    contextId: requestContext.contextId,
    taskId: requestContext.taskId,
    role: Role.ROLE_AGENT
  };
}

function buildPairMeshInspectionAgentResponse(
  requestContext: RequestContext,
  response: PairMeshInspectionResponse
): Message {
  const encoded = encodePairMeshInspectionResponse(response);
  return {
    ...encoded,
    contextId: requestContext.contextId,
    taskId: requestContext.taskId,
    role: Role.ROLE_AGENT
  };
}

function buildPairMeshActionAgentResponse(
  requestContext: RequestContext,
  response: Parameters<typeof encodePairMeshActionResponse>[0]
): Message {
  const encoded = encodePairMeshActionResponse(response);
  return {
    ...encoded,
    contextId: requestContext.contextId,
    taskId: requestContext.taskId,
    role: Role.ROLE_AGENT
  };
}

function buildPairMeshTaskAgentResponse(
  requestContext: RequestContext,
  response: Parameters<typeof encodePairMeshTaskResponse>[0]
): Message {
  const encoded = encodePairMeshTaskResponse(response);
  return {
    ...encoded,
    contextId: requestContext.contextId,
    taskId: requestContext.taskId,
    role: Role.ROLE_AGENT
  };
}
