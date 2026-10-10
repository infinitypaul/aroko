import {
  ActionApprovalBindingSchema,
  ActionExecutionRecordSchema,
  ActionIdSchema,
  PAIRMESH_PERMISSION_REQUEST_TTL_MS,
  PairMeshPermissionRequestSchema,
  PermissionRequestIdSchema,
  createPairMeshError,
  type ActionApprovalBinding,
  type ActionArtifactRecord,
  type ActionArtifactRef,
  type ActionExecutionRecord,
  type ActionExecutionStatus,
  type ActionId,
  type ActionParameters,
  type ActionResult,
  type ArtifactId,
  type PeerId,
  appendProgressEvent
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { ensureDefaultGrants, getGrantPolicy, setGrantPolicy } from "../auth/capabilities.js";
import type {
  PairMeshTestsConfig,
  PairMeshProcessExecutionConfig
} from "../local-config/schema.js";
import type { LocalSessionState } from "../session/schemas.js";
import { ActionArtifactStore } from "./artifacts.js";
import { readMutationJournal } from "./apply/mutation-journal.js";
import { readProcessSpawnJournal } from "./process/spawn-journal.js";
import {
  buildCanonicalProcessExecutionBytes,
  buildProcessExecutionArtifactBody,
  formatProcessCommandDisplay
} from "./process/artifact.js";
import { bindProcessExecution } from "./process/resolve.js";
import { projectOwnerProcessExecution } from "./process/owner-projection.js";
import { ChangeProposeExecutor } from "./change-propose-executor.js";
import { digestParameters } from "./digest.js";
import { ActionExecutorRegistry, FakeActionExecutor, type ActionExecutor } from "./executor.js";
import { assertActionTransition, isTerminalActionStatus } from "./lifecycle.js";
import {
  ProposalArtifactV1Schema,
  type LocalProposalView,
  type ProposalGenerator
} from "./proposal/index.js";
import { requireActionTypeDefinition } from "./registry.js";
import { RepositoryEditExecutor } from "./repository-edit-executor.js";
import { ProcessExecuteExecutor } from "./process-execute-executor.js";
import {
  assertRemoteTestsRunParameters,
  isSessionAllowedProfile,
  resolveTestProfile
} from "./tests/profile.js";
import { TestsRunExecutor } from "./tests-run-executor.js";
import { appendTransitionProgress, seedActionProgressEvents } from "./progress.js";
import { mapProviderActivityToProgressEvent } from "./provider-activity.js";
import type { ExecutionProviderSnapshot } from "../execution/provider-snapshot.js";

const nowIso = (date = new Date()): string => date.toISOString();

export interface RequestActionInput {
  actionId?: ActionId;
  requesterParticipantId: PeerId;
  targetParticipantId: PeerId;
  actionType: string;
  parameters?: ActionParameters;
  artifactRef?: ActionArtifactRef;
  threadId?: string;
  requirePairedPeer?: boolean;
  /**
   * R5-4 — create Action without auto-running when grant would otherwise allow
   * session execution (e.g. change.propose allow_session). Forces approval path.
   */
  deferExecution?: boolean;
  /** R5 — optional CollaborativeTask provenance. */
  taskId?: string;
  originProviderTurnId?: string;
  originProvenance?: string;
}

export interface BeginRequestActionResult {
  state: LocalSessionState;
  execution: ActionExecutionRecord;
  resume?: () => Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }>;
}

export interface ActionServiceOptions {
  stateFilePath: string;
  executorRegistry?: ActionExecutorRegistry;
  defaultExecutorFactory?: (actionType: string) => ActionExecutor;
  /** Receiver workspace root for change.propose / repository.edit / tests.run. */
  workspaceRoot?: string;
  /** Proposal-only generator (coding-agent backed or deterministic test double). */
  proposalGenerator?: ProposalGenerator;
  /** Receiver-owned tests.run profile source (from .pairmesh/config.json). */
  loadTestsConfig?: () => Promise<PairMeshTestsConfig> | PairMeshTestsConfig;
  /**
   * Optional controlled PATH directories for tests.run executable resolution.
   * When omitted, PairMesh uses process PATH minus workspace directories.
   */
  testsExecutablePathDirectories?: () => string[] | undefined;
  /** Receiver-owned process.execute config (from .pairmesh/config.json). */
  loadProcessConfig?: () =>
    Promise<PairMeshProcessExecutionConfig> | PairMeshProcessExecutionConfig;
  /** Optional controlled PATH directories for process.execute resolution. */
  processExecutablePathDirectories?: () => string[] | undefined;
    onActionRecordChange?: (event: {
    previous?: ActionExecutionRecord;
    next: ActionExecutionRecord;
  }) => void;
    onLiveActionPersist?: (execution: ActionExecutionRecord) => void | Promise<void>;
    resolveExecutionProviderSnapshot?: () =>
    Promise<ExecutionProviderSnapshot | undefined> | ExecutionProviderSnapshot | undefined;
}

export class ActionService {
  private readonly artifacts: ActionArtifactStore;
  private readonly executors: ActionExecutorRegistry;
  private readonly defaultExecutorFactory: (actionType: string) => ActionExecutor;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly workspaceRoot?: string;
  private readonly editExecutor?: RepositoryEditExecutor;
  private readonly testsRunExecutor?: TestsRunExecutor;
  private readonly processExecuteExecutor?: ProcessExecuteExecutor;
  private readonly loadTestsConfig?: ActionServiceOptions["loadTestsConfig"];
  private readonly testsExecutablePathDirectories?: ActionServiceOptions["testsExecutablePathDirectories"];
  private readonly loadProcessConfig?: ActionServiceOptions["loadProcessConfig"];
  private readonly processExecutablePathDirectories?: ActionServiceOptions["processExecutablePathDirectories"];
  private onActionRecordChange?: ActionServiceOptions["onActionRecordChange"];
  private onLiveActionPersist?: ActionServiceOptions["onLiveActionPersist"];
  private readonly resolveExecutionProviderSnapshot?: ActionServiceOptions["resolveExecutionProviderSnapshot"];

  public constructor(options: ActionServiceOptions) {
    this.artifacts = new ActionArtifactStore({ stateFilePath: options.stateFilePath });
    this.executors = options.executorRegistry ?? new ActionExecutorRegistry();
    this.defaultExecutorFactory =
      options.defaultExecutorFactory ?? (() => new FakeActionExecutor({ mode: "success" }));
    this.workspaceRoot = options.workspaceRoot;
    this.loadTestsConfig = options.loadTestsConfig;
    this.testsExecutablePathDirectories = options.testsExecutablePathDirectories;
    this.loadProcessConfig = options.loadProcessConfig;
    this.processExecutablePathDirectories = options.processExecutablePathDirectories;
    this.onActionRecordChange = options.onActionRecordChange;
    this.onLiveActionPersist = options.onLiveActionPersist;
    this.resolveExecutionProviderSnapshot = options.resolveExecutionProviderSnapshot;

    if (options.proposalGenerator && options.workspaceRoot) {
      this.executors.register(
        "change.propose",
        new ChangeProposeExecutor({
          generator: options.proposalGenerator,
          artifactStore: this.artifacts,
          workspaceRoot: options.workspaceRoot
        })
      );
    }
    if (options.workspaceRoot) {
      this.editExecutor = new RepositoryEditExecutor({
        artifactStore: this.artifacts,
        workspaceRoot: options.workspaceRoot
      });
      this.executors.register("repository.edit", this.editExecutor);
    }
    if (options.workspaceRoot && options.loadTestsConfig) {
      this.testsRunExecutor = new TestsRunExecutor({
        workspaceRoot: options.workspaceRoot,
        loadTestsConfig: options.loadTestsConfig,
        pathDirectories: options.testsExecutablePathDirectories
      });
      this.executors.register("tests.run", this.testsRunExecutor);
    }
    if (options.workspaceRoot && options.loadProcessConfig) {
      this.processExecuteExecutor = new ProcessExecuteExecutor({
        workspaceRoot: options.workspaceRoot,
        loadProcessConfig: options.loadProcessConfig,
        artifactStore: this.artifacts,
        pathDirectories: options.processExecutablePathDirectories
      });
      this.executors.register("process.execute", this.processExecuteExecutor);
    }
  }

    public setOnActionRecordChange(
    handler: ActionServiceOptions["onActionRecordChange"] | undefined
  ): void {
    this.onActionRecordChange = handler;
  }

    public setOnLiveActionPersist(
    handler: ActionServiceOptions["onLiveActionPersist"] | undefined
  ): void {
    this.onLiveActionPersist = handler;
  }

  /** Test helper for fault-injection against the real edit executor. */
  public get repositoryEditExecutor(): RepositoryEditExecutor | undefined {
    return this.editExecutor;
  }

  /** Test helper for process-invocation counts on tests.run. */
  public get testsRunExecutorInstance(): TestsRunExecutor | undefined {
    return this.testsRunExecutor;
  }

  /** Test helper for process-invocation counts on process.execute. */
  public get processExecuteExecutorInstance(): ProcessExecuteExecutor | undefined {
    return this.processExecuteExecutor;
  }

  public get artifactStore(): ActionArtifactStore {
    return this.artifacts;
  }

  public get executorRegistry(): ActionExecutorRegistry {
    return this.executors;
  }

  public findExecution(
    state: LocalSessionState,
    actionId: string
  ): ActionExecutionRecord | undefined {
    return (state.actionExecutions ?? []).find((entry) => entry.actionId === actionId);
  }

  public findArtifact(
    state: LocalSessionState,
    artifactId: string
  ): ActionArtifactRecord | undefined {
    return (state.actionArtifacts ?? []).find((entry) => entry.artifactId === artifactId);
  }

  /**
   * Local/receiver-only proposal retrieval for tests and future Control.
   * Does not expose filesystem paths. Never a remote A2A surface.
   */
  public async getProposal(
    state: LocalSessionState,
    query: { actionId?: ActionId; artifactId?: ArtifactId }
  ): Promise<LocalProposalView> {
    let record: ActionArtifactRecord | undefined;
    if (query.artifactId) {
      record = this.findArtifact(state, query.artifactId);
    } else if (query.actionId) {
      const execution = this.findExecution(state, query.actionId);
      const ref = execution?.result?.artifactRefs?.[0] ?? execution?.artifactRefs?.[0];
      if (ref) {
        record = this.findArtifact(state, ref.artifactId);
      } else {
        record = (state.actionArtifacts ?? []).find((entry) => entry.actionId === query.actionId);
      }
    }
    if (!record) {
      throw createPairMeshError({
        code: "pairmesh.artifact_not_found",
        message: "Proposal artifact not found."
      });
    }
    const bytes = await this.artifacts.readBytes(record);
    const body = ProposalArtifactV1Schema.parse(JSON.parse(bytes.toString("utf8")));
    return {
      ...body,
      artifactId: record.artifactId,
      contentHash: record.contentHash,
      byteSize: record.byteSize
    };
  }

  public async requestAction(
    state: LocalSessionState,
    input: RequestActionInput,
    now: Date = new Date()
  ): Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }> {
    const begun = await this.beginRequestAction(state, input, now);
    if (!begun.resume) {
      return { state: begun.state, execution: begun.execution };
    }
    return begun.resume();
  }

    public async beginRequestAction(
    state: LocalSessionState,
    input: RequestActionInput,
    now: Date = new Date()
  ): Promise<BeginRequestActionResult> {
    const definition = requireActionTypeDefinition(input.actionType);
    if (!definition.executable) {
      throw createPairMeshError({
        code: "pairmesh.action_unsupported",
        message: `Action type ${input.actionType} is not executable.`
      });
    }

    const actionId = input.actionId ?? ActionIdSchema.parse(`act_${randomUUID()}`);
    let parameters = input.parameters ?? {};
    let artifactRef = input.artifactRef;
    let createdProcessArtifact: ActionArtifactRecord | undefined;
    if (input.actionType === "tests.run") {
      parameters = await this.bindTestsRunParameters(parameters);
    }

    // process.execute binds only for new actionIds (immutable artifact per request).
    const existing = this.findExecution(state, actionId);
    if (existing && input.actionType === "process.execute") {
      this.assertSameMaterial(existing, {
        requesterParticipantId: input.requesterParticipantId,
        targetParticipantId: input.targetParticipantId,
        actionType: input.actionType,
        capabilityId: definition.capabilityId,
        parameterDigest: existing.parameterDigest,
        artifactRef: existing.artifactRefs?.[0] ?? input.artifactRef
      });
      const reconciled = await this.reconcileInterruptedMutation(state, existing, now);
      return { state: reconciled.state, execution: reconciled.execution };
    }

    if (input.actionType === "process.execute") {
      const bound = await this.bindProcessExecuteRequest(actionId, parameters, now);
      parameters = bound.parameters;
      artifactRef = bound.artifactRef;
      createdProcessArtifact = bound.artifact;
    }
    const boundInput: RequestActionInput = { ...input, parameters, artifactRef };
    const parameterDigest = digestParameters(parameters);
    if (existing) {
      this.assertSameMaterial(existing, {
        requesterParticipantId: boundInput.requesterParticipantId,
        targetParticipantId: boundInput.targetParticipantId,
        actionType: boundInput.actionType,
        capabilityId: definition.capabilityId,
        parameterDigest,
        artifactRef: boundInput.artifactRef
      });
      const reconciled = await this.reconcileInterruptedMutation(state, existing, now);
      return { state: reconciled.state, execution: reconciled.execution };
    }

    if (boundInput.requirePairedPeer !== false) {
      this.assertPairedRequester(state, boundInput.requesterParticipantId);
    }
    if (!state.sessionSecurity) {
      throw createPairMeshError({
        code: "pairmesh.session_requires_repair",
        message: "Session security is required for controlled actions."
      });
    }

    let nextState: LocalSessionState = {
      ...state,
      sessionSecurity: ensureDefaultGrants(
        state.sessionSecurity,
        boundInput.requesterParticipantId,
        now
      ),
      actionArtifacts: createdProcessArtifact
        ? [...(state.actionArtifacts ?? []), createdProcessArtifact]
        : state.actionArtifacts
    };

    if (definition.requiresArtifact && !boundInput.artifactRef) {
      throw createPairMeshError({
        code: "pairmesh.artifact_not_found",
        message: "This action type requires an artifact reference."
      });
    }

    for (const required of definition.requiresCapabilityIds ?? []) {
      if (getGrantPolicy(nextState, boundInput.requesterParticipantId, required) === "deny") {
        throw createPairMeshError({
          code: "pairmesh.action_not_authorized",
          message: `Missing prerequisite capability ${required}.`
        });
      }
    }

    const capabilityPolicy = getGrantPolicy(
      nextState,
      boundInput.requesterParticipantId,
      definition.capabilityId
    );

    if (capabilityPolicy === "deny") {
      const denied = this.createRecord({
        actionId,
        input: boundInput,
        capabilityId: definition.capabilityId,
        mutability: definition.mutability,
        parameterDigest,
        status: "denied",
        now,
        artifactRefs: boundInput.artifactRef ? [boundInput.artifactRef] : undefined
      });
      return { state: this.upsert(nextState, denied), execution: denied };
    }

    const sessionProfileAllowed =
      boundInput.actionType === "tests.run" &&
      typeof parameters.profile === "string" &&
      this.loadTestsConfig !== undefined &&
      isSessionAllowedProfile(await this.loadTestsConfig(), parameters.profile);

    const needsApproval =
      boundInput.deferExecution === true ||
      definition.requiresApproval ||
      capabilityPolicy === "approval_required" ||
      (definition.capabilityId === "repository.edit" && capabilityPolicy === "allow_session") ||
      (definition.capabilityId === "process.execute" && capabilityPolicy === "allow_session") ||
      (boundInput.actionType === "tests.run" &&
        capabilityPolicy === "allow_session" &&
        !sessionProfileAllowed);

    const normalizedTargetPaths = await this.resolveNormalizedTargetPaths(
      nextState,
      boundInput,
      definition.actionType
    );

    if (!needsApproval) {
      if (capabilityPolicy !== "allow_session") {
        throw createPairMeshError({
          code: "pairmesh.action_not_authorized",
          message: `Unsupported capability policy: ${capabilityPolicy}`
        });
      }
      const approved = this.createRecord({
        actionId,
        input: boundInput,
        capabilityId: definition.capabilityId,
        mutability: definition.mutability,
        parameterDigest,
        status: "approved",
        now,
        artifactRefs: boundInput.artifactRef ? [boundInput.artifactRef] : undefined
      });
      nextState = this.upsert(nextState, approved);
      return this.beginRunApproved(nextState, approved.actionId, now);
    }

    const approvalBinding = ActionApprovalBindingSchema.parse({
      requesterParticipantId: boundInput.requesterParticipantId,
      targetParticipantId: boundInput.targetParticipantId,
      actionId,
      capabilityId: definition.capabilityId,
      actionType: boundInput.actionType,
      parameterDigest,
      artifactId: boundInput.artifactRef?.artifactId,
      artifactContentHash: boundInput.artifactRef?.contentHash,
      normalizedTargetPaths,
      expiresAt: new Date(now.getTime() + PAIRMESH_PERMISSION_REQUEST_TTL_MS).toISOString()
    });
    const permissionRequestId = PermissionRequestIdSchema.parse(`perm_${randomUUID()}`);
    nextState = {
      ...nextState,
      permissionRequests: [
        ...(nextState.permissionRequests ?? []),
        PairMeshPermissionRequestSchema.parse({
          permissionRequestId,
          participantId: boundInput.requesterParticipantId,
          capabilityId: definition.capabilityId,
          correlationRequestId: actionId,
          threadId: boundInput.threadId,
          status: "pending",
          createdAt: nowIso(now),
          expiresAt: approvalBinding.expiresAt
        })
      ]
    };

    const pending = this.createRecord({
      actionId,
      input: boundInput,
      capabilityId: definition.capabilityId,
      mutability: definition.mutability,
      parameterDigest,
      status: "approval_required",
      now,
      permissionRequestId,
      approvalBinding,
      artifactRefs: boundInput.artifactRef ? [boundInput.artifactRef] : undefined
    });
    return { state: this.upsert(nextState, pending), execution: pending };
  }

  public async approveAction(
    state: LocalSessionState,
    input: { actionId: ActionId; decision: "allow-once" | "allow-session" | "deny" },
    now: Date = new Date()
  ): Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }> {
    const begun = await this.approveActionBegin(state, input, now);
    if (!begun.resume) {
      return { state: begun.state, execution: begun.execution };
    }
    return begun.resume();
  }

  /**
   * Approve/deny under a caller-owned exclusive section without running the
   * executor. Caller must persist `begun.state`, then optionally `begun.resume()`
   * outside the lock (live persist handles in-flight updates).
   */
  public async approveActionBegin(
    state: LocalSessionState,
    input: { actionId: ActionId; decision: "allow-once" | "allow-session" | "deny" },
    now: Date = new Date()
  ): Promise<BeginRequestActionResult> {
    const execution = this.require(state, input.actionId);
    if (execution.status !== "approval_required" || !execution.approvalBinding) {
      throw createPairMeshError({
        code: "pairmesh.action_invalid_transition",
        message: `Action ${execution.actionId} is not awaiting approval.`
      });
    }
    if (Date.parse(execution.approvalBinding.expiresAt) <= now.getTime()) {
      const expired = this.transition(execution, "expired", now);
      const withPermission = this.syncLinkedPermissionRequest(state, expired, "expired", now);
      return { state: this.upsert(withPermission, expired), execution: expired };
    }
    if (input.decision === "allow-session") {
      const definition = requireActionTypeDefinition(execution.actionType);
      if (
        execution.capabilityId === "repository.edit" ||
        execution.capabilityId === "process.execute" ||
        !definition.allowSessionApproval
      ) {
        throw createPairMeshError({
          code: "pairmesh.capability_not_allowed",
          message: "allow-session is not permitted for this action in the current Aroko release."
        });
      }
    }
    if (input.decision === "deny") {
      const denied = this.transition(execution, "denied", now);
      const withPermission = this.syncLinkedPermissionRequest(state, denied, "deny", now);
      return { state: this.upsert(withPermission, denied), execution: denied };
    }

    // R4-M1 fail-closed: never allow-once an opaque process.execute approval.
    if (
      input.decision === "allow-once" &&
      execution.actionType === "process.execute" &&
      !projectOwnerProcessExecution(execution)
    ) {
      throw createPairMeshError({
        code: "pairmesh.action_not_authorized",
        message:
          "Unable to display command details for this process.execute request. Approval unavailable."
      });
    }

    this.assertStillAuthorized(state, execution);
    this.assertBinding(execution, execution.approvalBinding);
    await this.assertArtifactStillMatchesBinding(state, execution);
    await this.assertTestsProfileStillMatches(execution);
    const nextState = this.syncLinkedPermissionRequest(state, execution, input.decision, now);
    const approved = this.transition({ ...execution, approvedAt: nowIso(now) }, "approved", now);
    return this.beginRunApproved(this.upsert(nextState, approved), approved.actionId, now);
  }

  public cancelAction(
    state: LocalSessionState,
    actionId: ActionId,
    now: Date = new Date()
  ): { state: LocalSessionState; execution: ActionExecutionRecord } {
    const execution = this.require(state, actionId);
    if (isTerminalActionStatus(execution.status)) {
      return { state, execution };
    }
    if (execution.status === "executing") {
      this.abortControllers.get(actionId)?.abort();
      const marked: ActionExecutionRecord = {
        ...execution,
        cancelRequested: true,
        updatedAt: nowIso(now)
      };
      return { state: this.upsert(state, marked), execution: marked };
    }
    const cancelled = this.transition({ ...execution, cancelRequested: true }, "cancelled", now);
    return { state: this.upsert(state, cancelled), execution: cancelled };
  }

  public async createTestArtifact(
    state: LocalSessionState,
    input: {
      actionId: ActionId;
      bytes: Buffer;
      artifactType?: ActionArtifactRecord["artifactType"];
    }
  ): Promise<{ state: LocalSessionState; artifact: ActionArtifactRecord }> {
    const artifact = await this.artifacts.createFinalizedArtifact({
      actionId: input.actionId,
      artifactType: input.artifactType ?? "patch_diff",
      bytes: input.bytes
    });
    return {
      state: {
        ...state,
        actionArtifacts: [...(state.actionArtifacts ?? []), artifact]
      },
      artifact
    };
  }

  private async runApproved(
    state: LocalSessionState,
    actionId: ActionId,
    now: Date
  ): Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }> {
    const begun = await this.beginRunApproved(state, actionId, now);
    if (!begun.resume) {
      return { state: begun.state, execution: begun.execution };
    }
    return begun.resume();
  }

  private async beginRunApproved(
    state: LocalSessionState,
    actionId: ActionId,
    now: Date
  ): Promise<BeginRequestActionResult> {
    const execution = this.require(state, actionId);
    if (execution.status === "unknown_outcome") {
      return { state, execution };
    }
    if (execution.status !== "approved") {
      throw createPairMeshError({
        code: "pairmesh.action_invalid_transition",
        message: `Cannot execute action in status ${execution.status}.`
      });
    }
    this.assertStillAuthorized(state, execution);
    if (execution.approvalBinding) {
      if (Date.parse(execution.approvalBinding.expiresAt) <= now.getTime()) {
        const expired = this.transition(execution, "expired", now);
        return { state: this.upsert(state, expired), execution: expired };
      }
      this.assertBinding(execution, execution.approvalBinding);
      await this.assertArtifactStillMatchesBinding(state, execution);
      await this.assertTestsProfileStillMatches(execution);
    }
    if (execution.artifactRefs?.[0]) {
      const artifact = (state.actionArtifacts ?? []).find(
        (entry) => entry.artifactId === execution.artifactRefs![0]!.artifactId
      );
      if (!artifact || artifact.contentHash !== execution.artifactRefs[0].contentHash) {
        throw createPairMeshError({
          code: "pairmesh.artifact_hash_mismatch",
          message: "Approved artifact is missing or hash-mismatched."
        });
      }
      await this.artifacts.readBytes(artifact);
    }

    const providerSnapshot = this.resolveExecutionProviderSnapshot
      ? await Promise.resolve(this.resolveExecutionProviderSnapshot())
      : undefined;

    const running = this.transition(
      {
        ...execution,
        executionStartedAt: nowIso(now),
        executorInvocationCount: execution.executorInvocationCount + 1,
        ...(providerSnapshot?.executionProviderId
          ? { executionProviderId: providerSnapshot.executionProviderId }
          : {}),
        ...(providerSnapshot?.executionProviderDisplayName
          ? { executionProviderDisplayName: providerSnapshot.executionProviderDisplayName }
          : {})
      },
      "executing",
      now
    );
    let stateAfterProvider = this.upsert(state, running);
    let executionAfterProvider = running;
    const executor =
      this.executors.get(running.actionType) ?? this.defaultExecutorFactory(running.actionType);
    this.executors.register(running.actionType, executor);
    const controller = new AbortController();
    this.abortControllers.set(actionId, controller);

    // Persist executing status immediately so watch/Control see in-flight work.
    await this.persistLiveAction(executionAfterProvider);

    const resume = async (): Promise<{
      state: LocalSessionState;
      execution: ActionExecutionRecord;
    }> => {
      let persistChain: Promise<void> = Promise.resolve();
      const scheduleLivePersist = (nextExecution: ActionExecutionRecord): void => {
        persistChain = persistChain
          .then(async () => {
            await this.persistLiveAction(nextExecution);
          })
          .catch(() => {
            // Live persist must never fail the worker.
          });
      };

      const outcome = await executor.execute(running, {
        abortSignal: controller.signal,
        workspaceRoot: this.workspaceRoot,
        artifactStore: this.artifacts,
        sessionState: stateAfterProvider,
        onProviderActivity: (event) => {
          const progressEvent = mapProviderActivityToProgressEvent({
            actionId,
            event,
            timestamp: nowIso(new Date())
          });
          executionAfterProvider = {
            ...executionAfterProvider,
            updatedAt: progressEvent.timestamp,
            progressEvents: appendProgressEvent(
              executionAfterProvider.progressEvents,
              progressEvent
            )
          };
          stateAfterProvider = this.upsert(stateAfterProvider, executionAfterProvider);
          scheduleLivePersist(executionAfterProvider);
        }
      });
      await persistChain;
      this.abortControllers.delete(actionId);
      const { result, artifacts } = outcome;

      const latest = this.findExecution(stateAfterProvider, actionId) ?? executionAfterProvider;
      if (latest.cancelRequested && result.status === "completed") {
        return this.applyResult(
          stateAfterProvider,
          latest,
          {
            ...result,
            status: "cancelled",
            summary: "Cancelled before durable completion."
          },
          now,
          artifacts
        );
      }
      if (isTerminalActionStatus(latest.status) && latest.status !== "executing") {
        return { state: stateAfterProvider, execution: latest };
      }
      const applied = this.applyResult(
        stateAfterProvider,
        executionAfterProvider,
        result,
        now,
        artifacts
      );
      await this.persistLiveAction(applied.execution);
      return applied;
    };

    return {
      state: stateAfterProvider,
      execution: executionAfterProvider,
      resume
    };
  }

  private applyResult(
    state: LocalSessionState,
    execution: ActionExecutionRecord,
    result: ActionResult,
    now: Date,
    artifacts?: ActionArtifactRecord[]
  ): { state: LocalSessionState; execution: ActionExecutionRecord } {
    const current = this.findExecution(state, execution.actionId) ?? execution;
    if (isTerminalActionStatus(current.status) && current.status !== "executing") {
      return { state, execution: current };
    }
    assertActionTransition("executing", result.status);
    const mergedArtifacts = [...(state.actionArtifacts ?? [])];
    for (const artifact of artifacts ?? []) {
      if (!mergedArtifacts.some((entry) => entry.artifactId === artifact.artifactId)) {
        mergedArtifacts.push(artifact);
      }
    }
        const transitioned = this.transition(current, result.status, now);
    const completed = ActionExecutionRecordSchema.parse({
      ...transitioned,
      // Keep request-bound artifactRefs only. Produced proposal artifacts live on result.
      artifactRefs: current.artifactRefs,
      result: {
        ...result,
        executorInvocationCount: current.executorInvocationCount
      },
      error: result.error
    });
    return {
      state: {
        ...this.upsert(state, completed),
        actionArtifacts: mergedArtifacts
      },
      execution: completed
    };
  }

  private assertSameMaterial(
    existing: ActionExecutionRecord,
    material: {
      requesterParticipantId: PeerId;
      targetParticipantId: PeerId;
      actionType: string;
      capabilityId: string;
      parameterDigest: string;
      artifactRef?: ActionArtifactRef;
    }
  ): void {
    const same =
      existing.requesterParticipantId === material.requesterParticipantId &&
      existing.targetParticipantId === material.targetParticipantId &&
      existing.actionType === material.actionType &&
      existing.capabilityId === material.capabilityId &&
      existing.parameterDigest === material.parameterDigest &&
      (existing.artifactRefs?.[0]?.artifactId ?? undefined) ===
        (material.artifactRef?.artifactId ?? undefined) &&
      (existing.artifactRefs?.[0]?.contentHash ?? undefined) ===
        (material.artifactRef?.contentHash ?? undefined);
    if (!same) {
      throw createPairMeshError({
        code: "pairmesh.action_conflict",
        message: "actionId was reused with different material fields."
      });
    }
  }

  private assertBinding(execution: ActionExecutionRecord, binding: ActionApprovalBinding): void {
    const artifact = execution.artifactRefs?.[0];
    if (
      binding.actionId !== execution.actionId ||
      binding.requesterParticipantId !== execution.requesterParticipantId ||
      binding.targetParticipantId !== execution.targetParticipantId ||
      binding.capabilityId !== execution.capabilityId ||
      binding.actionType !== execution.actionType ||
      binding.parameterDigest !== execution.parameterDigest ||
      (binding.artifactId ?? undefined) !== (artifact?.artifactId ?? undefined) ||
      (binding.artifactContentHash ?? undefined) !== (artifact?.contentHash ?? undefined)
    ) {
      throw createPairMeshError({
        code: "pairmesh.action_binding_mismatch",
        message: "Approval binding does not match the action execution."
      });
    }
  }

  /**
   * Receiver-authoritative: allow-once approval does not survive peer revocation
   * or a policy change to deny before apply begins.
   */
  private assertStillAuthorized(state: LocalSessionState, execution: ActionExecutionRecord): void {
    this.assertPairedRequester(state, execution.requesterParticipantId);
    const policy = getGrantPolicy(state, execution.requesterParticipantId, execution.capabilityId);
    if (policy === "deny") {
      throw createPairMeshError({
        code: "pairmesh.action_not_authorized",
        message: "Capability is denied; prior allow-once approval cannot execute."
      });
    }
  }

  private async resolveNormalizedTargetPaths(
    state: LocalSessionState,
    input: RequestActionInput,
    actionType: string
  ): Promise<string[] | undefined> {
    if (actionType === "repository.edit") {
      if (!input.artifactRef) {
        return undefined;
      }
      const proposal = await this.loadProposalFromRef(state, input.artifactRef);
      return [...proposal.affectedPaths].sort();
    }
    if (Array.isArray((input.parameters as { paths?: unknown } | undefined)?.paths)) {
      return (input.parameters as { paths: string[] }).paths;
    }
    return undefined;
  }

  private async bindTestsRunParameters(parameters: ActionParameters): Promise<ActionParameters> {
    if (!this.workspaceRoot || !this.loadTestsConfig) {
      throw createPairMeshError({
        code: "pairmesh.action_unsupported",
        message: "tests.run requires a configured workspace and profile source."
      });
    }
    const { profileName } = assertRemoteTestsRunParameters(parameters);
    const testsConfig = await this.loadTestsConfig();
    const resolved = await resolveTestProfile({
      name: profileName,
      testsConfig,
      workspaceRoot: this.workspaceRoot,
      pathDirectories: this.testsExecutablePathDirectories?.()
    });
    return {
      profile: resolved.name,
      profileDigest: resolved.digest
    };
  }

  private async assertTestsProfileStillMatches(execution: ActionExecutionRecord): Promise<void> {
    if (execution.actionType !== "tests.run") {
      return;
    }
    if (!this.workspaceRoot || !this.loadTestsConfig) {
      throw createPairMeshError({
        code: "pairmesh.action_unsupported",
        message: "tests.run is not configured on this receiver."
      });
    }
    const profileName =
      typeof execution.parameters.profile === "string" ? execution.parameters.profile : "";
    const boundDigest =
      typeof execution.parameters.profileDigest === "string"
        ? execution.parameters.profileDigest
        : "";
    const testsConfig = await this.loadTestsConfig();
    const resolved = await resolveTestProfile({
      name: profileName,
      testsConfig,
      workspaceRoot: this.workspaceRoot,
      pathDirectories: this.testsExecutablePathDirectories?.()
    });
    if (resolved.digest !== boundDigest) {
      throw createPairMeshError({
        code: "pairmesh.test_profile_changed",
        message: "Test profile definition changed since this action was bound."
      });
    }
  }

  private async loadProposalFromRef(
    state: LocalSessionState,
    artifactRef: ActionArtifactRef
  ): Promise<import("./proposal/schema.js").ProposalArtifactV1> {
    const record = this.findArtifact(state, artifactRef.artifactId);
    if (!record) {
      throw createPairMeshError({
        code: "pairmesh.artifact_not_found",
        message: "Referenced proposal artifact is not present on the receiver."
      });
    }
    if (record.contentHash !== artifactRef.contentHash) {
      throw createPairMeshError({
        code: "pairmesh.artifact_hash_mismatch",
        message: "Referenced artifact hash does not match stored bytes."
      });
    }
    const bytes = await this.artifacts.readBytes(record);
    try {
      return ProposalArtifactV1Schema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: "Referenced artifact is not a valid pairmesh.proposal.v1 body."
      });
    }
  }

  private async assertArtifactStillMatchesBinding(
    state: LocalSessionState,
    execution: ActionExecutionRecord
  ): Promise<void> {
    const binding = execution.approvalBinding;
    const ref = execution.artifactRefs?.[0];
    if (!binding || !ref || execution.actionType !== "repository.edit") {
      return;
    }
    const proposal = await this.loadProposalFromRef(state, ref);
    const artifactPaths = [...proposal.affectedPaths].sort();
    const boundPaths = [...(binding.normalizedTargetPaths ?? [])].sort();
    if (
      artifactPaths.length !== boundPaths.length ||
      artifactPaths.some((path, index) => path !== boundPaths[index])
    ) {
      throw createPairMeshError({
        code: "pairmesh.action_binding_mismatch",
        message: "Proposal paths no longer match the approval binding."
      });
    }
    if (binding.artifactContentHash && binding.artifactContentHash !== ref.contentHash) {
      throw createPairMeshError({
        code: "pairmesh.action_binding_mismatch",
        message: "Artifact hash no longer matches the approval binding."
      });
    }
  }

  private async reconcileInterruptedMutation(
    state: LocalSessionState,
    execution: ActionExecutionRecord,
    now: Date
  ): Promise<{ state: LocalSessionState; execution: ActionExecutionRecord }> {
    if (execution.status !== "executing") {
      return { state, execution };
    }
    if (execution.actionType === "repository.edit") {
      const journal = await readMutationJournal(this.artifacts.rootDir, execution.actionId);
      // R22-3: applying OR applied → unknown_outcome (mutation may have begun).
      if (journal?.phase === "applied" || journal?.phase === "applying") {
        const unknown = this.transition(
          {
            ...execution,
            result: {
              actionId: execution.actionId,
              status: "unknown_outcome",
              summary:
                "Aroko cannot prove whether this change was fully applied. Human reconciliation required.",
              unknownOutcome: true,
              executorInvocationCount: execution.executorInvocationCount
            },
            error: {
              code: "pairmesh.action_unknown_outcome",
              message:
                journal.phase === "applying"
                  ? "Mutation journal phase applying: filesystem mutation may have started."
                  : "Mutation journal indicates apply may have completed."
            }
          },
          "unknown_outcome",
          now
        );
        return { state: this.upsert(state, unknown), execution: unknown };
      }
    }
    if (execution.actionType === "process.execute") {
      const journal = await readProcessSpawnJournal(this.artifacts.rootDir, execution.actionId);
      if (journal?.phase === "spawn_committed") {
        const unknown = this.transition(
          {
            ...execution,
            result: {
              actionId: execution.actionId,
              status: "unknown_outcome",
              summary: "Interrupted after process spawn commitment; outcome unknown. Not re-run.",
              unknownOutcome: true,
              executorInvocationCount: execution.executorInvocationCount
            },
            error: {
              code: "pairmesh.action_unknown_outcome",
              message: "Process spawn journal indicates the process may have started."
            }
          },
          "unknown_outcome",
          now
        );
        return { state: this.upsert(state, unknown), execution: unknown };
      }
    }
    return { state, execution };
  }

  private async bindProcessExecuteRequest(
    actionId: ActionId,
    parameters: ActionParameters,
    now: Date
  ): Promise<{
    parameters: ActionParameters;
    artifactRef: ActionArtifactRef;
    artifact: ActionArtifactRecord;
  }> {
    if (!this.workspaceRoot || !this.loadProcessConfig) {
      throw createPairMeshError({
        code: "pairmesh.action_unsupported",
        message: "process.execute requires a configured workspace and process config."
      });
    }
    const processConfig = await this.loadProcessConfig();
    const bound = await bindProcessExecution({
      parameters,
      workspaceRoot: this.workspaceRoot,
      processConfig,
      pathDirectories: this.processExecutablePathDirectories?.()
    });
    const body = buildProcessExecutionArtifactBody({
      bound,
      createdAt: nowIso(now)
    });
    const bytes = buildCanonicalProcessExecutionBytes(body);
    const artifact = await this.artifacts.createFinalizedArtifact({
      actionId,
      artifactType: "process_execution",
      bytes
    });
    const artifactRef: ActionArtifactRef = {
      artifactId: artifact.artifactId,
      contentHash: artifact.contentHash,
      artifactType: "process_execution"
    };
    return {
      artifact,
      artifactRef,
      parameters: {
        executable: bound.executableBasename,
        args: bound.args,
        cwd: bound.cwdRelative,
        timeoutMs: bound.timeoutMs,
        maxOutputBytes: bound.maxOutputBytes,
        resolvedExecutableIdentity: bound.resolved.identity,
        envPolicyDigest: bound.envPolicyDigest,
        workspaceIdentity: bound.workspaceIdentity,
        commandDisplay: formatProcessCommandDisplay(bound.executableBasename, bound.args)
      }
    };
  }

  private assertPairedRequester(state: LocalSessionState, requesterParticipantId: PeerId): void {
    if (!state.peers.some((entry) => entry.participant.id === requesterParticipantId)) {
      throw createPairMeshError({
        code: "pairmesh.authentication_required",
        message: "Requester is not a paired participant in this session."
      });
    }
  }

  private syncLinkedPermissionRequest(
    state: LocalSessionState,
    execution: ActionExecutionRecord,
    decision: "allow-once" | "allow-session" | "deny" | "expired",
    now: Date
  ): LocalSessionState {
    const permissionRequestId = execution.permissionRequestId;
    if (!permissionRequestId) {
      return state;
    }

    let nextState: LocalSessionState = {
      ...state,
      permissionRequests: (state.permissionRequests ?? []).map((entry) => {
        if (entry.permissionRequestId !== permissionRequestId || entry.status !== "pending") {
          return entry;
        }
        if (decision === "expired") {
          return {
            ...entry,
            status: "expired" as const,
            decidedAt: nowIso(now)
          };
        }
        return {
          ...entry,
          status: decision === "deny" ? ("denied" as const) : ("approved" as const),
          decision: decision === "deny" ? ("deny" as const) : decision,
          decidedAt: nowIso(now),
          auditedEvents: [
            ...new Set([
              ...(entry.auditedEvents ?? []),
              ...(decision === "deny" ? (["denied"] as const) : (["allowed"] as const))
            ])
          ]
        };
      })
    };

    if (decision === "allow-session") {
      nextState = setGrantPolicy(
        nextState,
        execution.requesterParticipantId,
        execution.capabilityId,
        "allow_session",
        now
      );
    }

    return nextState;
  }

  private require(state: LocalSessionState, actionId: ActionId): ActionExecutionRecord {
    const execution = this.findExecution(state, actionId);
    if (!execution) {
      throw createPairMeshError({
        code: "pairmesh.action_not_found",
        message: "Action execution not found."
      });
    }
    return execution;
  }

  private createRecord(input: {
    actionId: ActionId;
    input: RequestActionInput;
    capabilityId: ActionExecutionRecord["capabilityId"];
    mutability: ActionExecutionRecord["mutability"];
    parameterDigest: string;
    status: ActionExecutionStatus;
    now: Date;
    permissionRequestId?: string;
    approvalBinding?: ActionApprovalBinding;
    artifactRefs?: ActionArtifactRef[];
  }): ActionExecutionRecord {
    const timestamp = nowIso(input.now);
    const record = ActionExecutionRecordSchema.parse({
      actionId: input.actionId,
      requesterParticipantId: input.input.requesterParticipantId,
      targetParticipantId: input.input.targetParticipantId,
      actionType: input.input.actionType,
      capabilityId: input.capabilityId,
      status: input.status,
      parameters: input.input.parameters ?? {},
      parameterDigest: input.parameterDigest,
      mutability: input.mutability,
      createdAt: timestamp,
      updatedAt: timestamp,
      permissionRequestId: input.permissionRequestId,
      approvalBinding: input.approvalBinding,
      artifactRefs: input.artifactRefs,
      executorInvocationCount: 0,
      ...(input.input.taskId ? { taskId: input.input.taskId } : {}),
      ...(input.input.originProviderTurnId
        ? { originProviderTurnId: input.input.originProviderTurnId }
        : {}),
      ...(input.input.originProvenance ? { originProvenance: input.input.originProvenance } : {}),
      auditedEvents: [
        "requested",
        ...(input.status === "approval_required"
          ? (["authorization_required"] as const)
          : input.status === "denied"
            ? (["denied"] as const)
            : [])
      ],
      progressEvents: seedActionProgressEvents({
        actionId: input.actionId,
        status: input.status,
        actionType: input.input.actionType,
        timestamp
      })
    });
    this.emitRecordChange(undefined, record);
    return record;
  }

  private transition(
    execution: ActionExecutionRecord,
    to: ActionExecutionStatus,
    now: Date
  ): ActionExecutionRecord {
    assertActionTransition(execution.status, to);
    const timestamp = nowIso(now);
    const next = {
      ...execution,
      status: to,
      updatedAt: timestamp,
      completedAt: isTerminalActionStatus(to) ? timestamp : execution.completedAt,
      auditedEvents: [...new Set([...(execution.auditedEvents ?? []), auditMark(to)])],
      progressEvents: appendTransitionProgress(execution, to, timestamp)
    };
    this.emitRecordChange(execution, next);
    return next;
  }

  private emitRecordChange(
    previous: ActionExecutionRecord | undefined,
    next: ActionExecutionRecord
  ): void {
    if (!this.onActionRecordChange) {
      return;
    }
    try {
      this.onActionRecordChange({ previous, next });
    } catch {
      // Owner presence must never break the action path.
    }
  }

  private async persistLiveAction(execution: ActionExecutionRecord): Promise<void> {
    if (!this.onLiveActionPersist) {
      return;
    }
    try {
      await this.onLiveActionPersist(execution);
    } catch {
      // Live persist must never break the action path.
    }
  }

  private upsert(state: LocalSessionState, execution: ActionExecutionRecord): LocalSessionState {
    return {
      ...state,
      actionExecutions: [
        ...(state.actionExecutions ?? []).filter((entry) => entry.actionId !== execution.actionId),
        execution
      ]
    };
  }
}

function auditMark(
  status: ActionExecutionStatus
): NonNullable<ActionExecutionRecord["auditedEvents"]>[number] {
  switch (status) {
    case "approval_required":
      return "authorization_required";
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "executing":
      return "execution_started";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "unknown_outcome":
      return "unknown_outcome";
    case "partially_completed":
      return "partially_completed";
    default:
      return "requested";
  }
}
