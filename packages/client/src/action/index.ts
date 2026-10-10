export { canonicalizeForDigest, digestParameters, sha256Hex } from "./digest.js";
export {
  listActionTypeDefinitions,
  getActionTypeDefinition,
  requireActionTypeDefinition,
  type ActionTypeDefinition,
  type FakeExecutorMode
} from "./registry.js";
export { assertActionTransition, isTerminalActionStatus } from "./lifecycle.js";
export { ActionArtifactStore } from "./artifacts.js";
export {
  FakeActionExecutor,
  ActionExecutorRegistry,
  type ActionExecutor,
  type ActionExecutorContext,
  type ActionExecutorOutcome
} from "./executor.js";
export {
  ChangeProposeExecutor,
  type ChangeProposeExecutorOptions,
  type ChangeProposeExecutorContext
} from "./change-propose-executor.js";
export {
  RepositoryEditExecutor,
  type RepositoryEditExecutorOptions
} from "./repository-edit-executor.js";
export { TestsRunExecutor, type TestsRunExecutorOptions } from "./tests-run-executor.js";
export {
  assertRemoteTestsRunParameters,
  buildControlledPathDirectories,
  computeProfileDigest,
  listV1AllowedExecutableBasenames,
  resolveAllowlistedExecutable,
  resolveTestProfile,
  type ResolvedTestProfile,
  type ResolveTestProfileOptions
} from "./tests/profile.js";
export {
  preparePatchApply,
  commitPatchApply,
  type ApplyFaultMode,
  type PatchApplyPlan,
  type PatchApplyResult
} from "./apply/patch-applicator.js";
export { parseUnifiedDiffSections, applyHunksToText } from "./apply/unified-diff-apply.js";
export {
  PROPOSAL_FORMAT_V1,
  PROPOSAL_V1_LIMITS,
  ProposalArtifactV1Schema,
  CodingAgentProposalGenerator,
  StaticProposalGenerator,
  digestWorkingTree,
  normalizeProposalRelativePath,
  assertProposalPathInsideWorkspace,
  assertCommitPathConfined,
  isSensitiveRelativePath,
  SENSITIVE_PATH_SEGMENTS,
  parseAndNormalizeUnifiedDiff,
  buildCanonicalProposalBytes,
  hashProposalArtifact,
  type ProposalArtifactV1,
  type ProposalGenerator,
  type LocalProposalView
} from "./proposal/index.js";
export { ActionService, type RequestActionInput, type ActionServiceOptions } from "./service.js";
export {
  processPairMeshActionWireRequest,
  toWireActionView,
  type ProcessPairMeshActionWireOptions
} from "./remote-handler.js";
export {
  buildActionMirrorFromWire,
  findActionExecution,
  findLinkedActionForPermission,
  listPendingActionExecutions,
  toActionSafeView,
  upsertActionExecution,
  upsertMirroredActionFromWire,
  type ActionSafeView
} from "./session-bridge.js";
export {
  assertRemoteProcessExecuteParameters,
  bindProcessExecution,
  computeExecutableIdentity,
  computeEnvPolicyDigest,
  computeWorkspaceIdentity,
  isShellInterpreterBasename,
  PROCESS_EXECUTE_ABSOLUTE_TIMEOUT_MS,
  PROCESS_EXECUTE_DEFAULT_MAX_OUTPUT_BYTES,
  resolveProcessExecutable,
  validateProcessCwd,
  type BoundProcessExecution,
  type ResolvedProcessExecutable
} from "./process/resolve.js";
export {
  assertNoShellHostInvocation,
  assertResolvedExecutableNotWindowsShellScript,
  isShellHostBasename,
  isWindowsShellScriptPath,
  SHELL_HOST_BASENAMES,
  WINDOWS_SHELL_SCRIPT_EXTENSIONS
} from "./process/shell-host-policy.js";
export {
  formatProcessCommandDisplay,
  PROCESS_EXECUTION_FORMAT_V1,
  ProcessExecutionArtifactV1Schema,
  type ProcessExecutionArtifactV1
} from "./process/artifact.js";
export {
  isOwnerProcessApprovalDisplayReady,
  projectOwnerProcessExecution,
  projectOwnerProcessExecutionFromParameters,
  type OwnerProcessExecutionView
} from "./process/owner-projection.js";
export {
  appendTransitionProgress,
  buildStatusProgressEvent,
  mergeMirroredActionProgress,
  progressPhaseForActionStatus,
  projectProgressForViewer,
  resolveActionProgressViewer,
  seedActionProgressEvents,
  type ProgressViewerRole
} from "./progress.js";
export {
  mapInspectionProgressToProgressEvent,
  mapInspectionProgressToProviderActivity,
  mapProviderActivityToProgressEvent
} from "./provider-activity.js";
export {
  DEFAULT_RECEIVER_ACTIVITY_LIMIT,
  MAX_RECEIVER_ACTIVITY_LIMIT,
  formatOwnerActivityLabel,
  latestOwnerActivityLabel,
  prepareOwnerActivityTimeline,
  summarizeOwnerActivity,
  type OwnerActivityItem,
  type OwnerActivitySafeMetadata,
  type OwnerActivitySummary
} from "./owner-activity-summary.js";
export {
  WATCH_POLL_MS,
  WATCH_IDLE_POLL_MS,
  diffWatchTimelineKeys,
  enrichInspectionForWatch,
  formatWatchEmptyState,
  formatWatchHeader,
  formatWatchReviewHandoff,
  formatWatchSelectionLine,
  formatWatchSelectionPrompt,
  formatWatchTimelineLines,
  formatWatchWaitingState,
  isWatchableActiveAction,
  isWatchableActiveInspection,
  isWatchableActiveWork,
  isWatchActionLive,
  isWatchInspectionCandidate,
  isWatchInspectionLive,
  isWatchProposalReviewable,
  isWatchWorkLive,
  mergeWatchCandidates,
  prepareWatchTimeline,
  progressEventWatchKey,
  resolveWatchPollIntervalMs,
  shouldKeepWaitingForActiveWork,
  shouldResumeIdleWaitAfterWatch,
  shouldHoldWatchForReviewKeypress,
  shouldReleaseWatchReviewHoldForOtherWork,
  formatWatchLeavingReviewHoldForNewWork,
  watchCandidateUpdatedAt,
  watchUxContainsOpaqueActionId,
  watchUxContainsOpaqueRequestId,
  watchUxContainsOpaqueWorkId,
  type WatchActionCandidate,
  type WatchCandidate,
  type WatchInspectionCandidate,
  type WatchTimelineLine
} from "./watch-present.js";
