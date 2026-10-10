import type {
  AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { parsePairMeshPayloadFromMessage, type LocalStateStore } from "@pairmesh/client";
import { PairMeshAuthorizationError, type TaskOwnershipRegistry } from "./auth.js";
import { recordReceiverAuthFailure } from "./audit-hooks.js";

/**
 * Wraps an {@link A2ARequestHandler} so task-scoped methods require an
 * authenticated PairMesh participant that owns the task.
 *
 * `sendMessage` stays open at this layer because the join handshake is
 * authenticated by its invite secret, not by a bearer; `PairMeshAgentExecutor`
 * enforces authentication for the protected skills it dispatches.
 */
export class AuthenticatedPairMeshRequestHandler implements A2ARequestHandler {
  private readonly delegate: A2ARequestHandler;
  private readonly taskOwnership: TaskOwnershipRegistry;
  private readonly stateStore?: LocalStateStore;

  public constructor(
    delegate: A2ARequestHandler,
    taskOwnership: TaskOwnershipRegistry,
    stateStore?: LocalStateStore
  ) {
    this.delegate = delegate;
    this.taskOwnership = taskOwnership;
    this.stateStore = stateStore;
  }

  public async getAgentCard(): Promise<AgentCard> {
    return await this.delegate.getAgentCard();
  }

  public async getAuthenticatedExtendedAgentCard(
    params: GetExtendedAgentCardRequest,
    context: ServerCallContext
  ): Promise<AgentCard> {
    requireParticipant(context, "read the extended agent card", this.stateStore);
    return await this.delegate.getAuthenticatedExtendedAgentCard(params, context);
  }

  public async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext
  ): Promise<Message | Task> {
    requireParticipantUnlessJoin(params, context, this.stateStore);
    return await this.delegate.sendMessage(params, context);
  }

  public sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext
  ): AsyncGenerator<StreamResponse, void, undefined> {
    requireParticipantUnlessJoin(params, context, this.stateStore);
    return this.delegate.sendMessageStream(params, context);
  }

  public async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    const participantId = requireParticipant(context, "read a PairMesh task", this.stateStore);
    this.taskOwnership.assertOwnership(params.id, participantId);
    return await this.delegate.getTask(params, context);
  }

  public async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const participantId = requireParticipant(context, "cancel a PairMesh task", this.stateStore);
    this.taskOwnership.assertOwnership(params.id, participantId);
    return await this.delegate.cancelTask(params, context);
  }

  public async listTasks(
    params: ListTasksRequest,
    context: ServerCallContext
  ): Promise<ListTasksResponse> {
    requireParticipant(context, "list PairMesh tasks", this.stateStore);
    return await this.delegate.listTasks(params, context);
  }

  public async createTaskPushNotificationConfig(
    params: TaskPushNotificationConfig,
    context: ServerCallContext
  ): Promise<TaskPushNotificationConfig> {
    requireParticipant(context, "configure push notifications", this.stateStore);
    return await this.delegate.createTaskPushNotificationConfig(params, context);
  }

  public async getTaskPushNotificationConfig(
    params: GetTaskPushNotificationConfigRequest,
    context: ServerCallContext
  ): Promise<TaskPushNotificationConfig> {
    requireParticipant(context, "read push notification configuration", this.stateStore);
    return await this.delegate.getTaskPushNotificationConfig(params, context);
  }

  public async listTaskPushNotificationConfigs(
    params: ListTaskPushNotificationConfigsRequest,
    context: ServerCallContext
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    requireParticipant(context, "list push notification configuration", this.stateStore);
    return await this.delegate.listTaskPushNotificationConfigs(params, context);
  }

  public async deleteTaskPushNotificationConfig(
    params: DeleteTaskPushNotificationConfigRequest,
    context: ServerCallContext
  ): Promise<void> {
    requireParticipant(context, "delete push notification configuration", this.stateStore);
    await this.delegate.deleteTaskPushNotificationConfig(params, context);
  }

  public resubscribe(
    params: SubscribeToTaskRequest,
    context: ServerCallContext
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const participantId = requireParticipant(
      context,
      "resubscribe to a PairMesh task",
      this.stateStore
    );
    this.taskOwnership.assertOwnership(params.id, participantId);
    return this.delegate.resubscribe(params, context);
  }
}

/**
 * Join is the only message a caller may send without a session bearer: the
 * single-use invite secret inside the payload is its credential.
 */
function requireParticipantUnlessJoin(
  params: SendMessageRequest,
  context: ServerCallContext,
  stateStore?: LocalStateStore
): void {
  const envelope = params.message ? parsePairMeshPayloadFromMessage(params.message) : undefined;
  if (envelope?.type === "pairmesh.join.request") {
    return;
  }

  requireParticipant(context, "send a message to this PairMesh agent", stateStore);
}

function requireParticipant(
  context: ServerCallContext,
  action: string,
  stateStore?: LocalStateStore
): string {
  const user = context.user;
  if (!user?.isAuthenticated || user.userName.length === 0) {
    if (stateStore) {
      void recordReceiverAuthFailure(stateStore, {
        reason: "missing_credential",
        skill: "a2a.message"
      });
    }
    throw new PairMeshAuthorizationError(
      "pairmesh.authentication_required",
      `A PairMesh session credential is required to ${action}.`
    );
  }
  return user.userName;
}
