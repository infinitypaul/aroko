import {
  createPairMeshError,
  type ActionArtifactRecord,
  type ActionExecutionRecord,
  type ActionResult
} from "@pairmesh/protocol";
import { mayIncludeSourceReferences } from "../auth/capabilities.js";
import type { LocalSessionState } from "../session/schemas.js";
import type { ActionArtifactStore } from "./artifacts.js";
import {
  clearMutationJournal,
  readMutationJournal,
  writeMutationJournal
} from "./apply/mutation-journal.js";
import {
  commitPatchApply,
  preparePatchApply,
  type ApplyFaultMode
} from "./apply/patch-applicator.js";
import { withWorkspaceApplyLock } from "./apply/workspace-lock.js";
import type { ActionExecutor, ActionExecutorContext, ActionExecutorOutcome } from "./executor.js";
import {
  PROPOSAL_FORMAT_V1,
  ProposalArtifactV1Schema,
  type ProposalArtifactV1
} from "./proposal/schema.js";
import { parseAndNormalizeUnifiedDiff } from "./proposal/unified-diff.js";

export interface RepositoryEditExecutorOptions {
  artifactStore: ActionArtifactStore;
  workspaceRoot: string;
  /** Test-only fault injection. */
  faultMode?: ApplyFaultMode;
}

export class RepositoryEditExecutor implements ActionExecutor {
  public readonly id = "repository-edit-executor";
  public applyInvocationCount = 0;
  private readonly artifactStore: ActionArtifactStore;
  private readonly workspaceRoot: string;
  private faultMode: ApplyFaultMode;

  public constructor(options: RepositoryEditExecutorOptions) {
    this.artifactStore = options.artifactStore;
    this.workspaceRoot = options.workspaceRoot;
    this.faultMode = options.faultMode ?? "none";
  }

  /** Test helper — change fault mode without reconstructing ActionService. */
  public setFaultMode(mode: ApplyFaultMode): void {
    this.faultMode = mode;
  }

  public async execute(
    execution: ActionExecutionRecord,
    context: ActionExecutorContext
  ): Promise<ActionExecutorOutcome> {
    this.applyInvocationCount += 1;
    const workspaceRoot = context.workspaceRoot ?? this.workspaceRoot;
    const artifactStore = context.artifactStore ?? this.artifactStore;
    const actionsRoot = artifactStore.rootDir;

    if (context.abortSignal?.aborted) {
      return {
        result: cancelledResult(execution.actionId, this.applyInvocationCount, "before start")
      };
    }

    const existingJournal = await readMutationJournal(actionsRoot, execution.actionId);
    // R22-3: both applying and applied mean mutation may have begun — fail closed.
    if (existingJournal?.phase === "applied" || existingJournal?.phase === "applying") {
      return {
        result: {
          actionId: execution.actionId,
          status: "unknown_outcome",
          summary:
            "Aroko cannot prove whether this change was fully applied. Human reconciliation required.",
          unknownOutcome: true,
          outputs: {
            actionType: "repository.edit",
            appliedCount: existingJournal.appliedPaths.length,
            journalPhase: existingJournal.phase
          },
          error: {
            code: "pairmesh.action_unknown_outcome",
            message:
              "Mutation journal indicates apply may have started or completed. Do not auto-retry."
          },
          executorInvocationCount: this.applyInvocationCount
        }
      };
    }

    let proposal: ProposalArtifactV1;
    let artifactRecord: ActionArtifactRecord;
    try {
      const loaded = await loadAndVerifyProposal(execution, artifactStore, context.sessionState);
      proposal = loaded.proposal;
      artifactRecord = loaded.record;
    } catch (error) {
      return { result: mapFailure(execution.actionId, error, this.applyInvocationCount) };
    }

    const bindingPaths = [...(execution.approvalBinding?.normalizedTargetPaths ?? [])].sort();
    const proposalPaths = [...proposal.affectedPaths].sort();
    if (
      bindingPaths.length === 0 ||
      bindingPaths.length !== proposalPaths.length ||
      bindingPaths.some((path, index) => path !== proposalPaths[index])
    ) {
      return {
        result: mapFailure(
          execution.actionId,
          createPairMeshError({
            code: "pairmesh.action_binding_mismatch",
            message: "Approved path set does not match proposal artifact paths."
          }),
          this.applyInvocationCount
        )
      };
    }

    // Re-normalize + path-safety immediately before mutation (TOCTOU close).
    let plan;
    try {
      await parseAndNormalizeUnifiedDiff(proposal.unifiedDiff, workspaceRoot);
      plan = await preparePatchApply({
        workspaceRoot,
        unifiedDiff: proposal.unifiedDiff,
        allowedPaths: proposalPaths
      });
    } catch (error) {
      return { result: mapFailure(execution.actionId, error, this.applyInvocationCount) };
    }

    if (context.abortSignal?.aborted) {
      return {
        result: cancelledResult(execution.actionId, this.applyInvocationCount, "after validation")
      };
    }

    return withWorkspaceApplyLock(workspaceRoot, async () => {
      await writeMutationJournal(actionsRoot, {
        actionId: execution.actionId,
        phase: "applying",
        workspaceRoot,
        paths: proposalPaths,
        appliedPaths: [],
        updatedAt: new Date().toISOString()
      });

      // Crash injection: journal is durable; mutation may have begun from a restart POV.
      if (this.faultMode === "after_journal_applying") {
        return {
          result: {
            actionId: execution.actionId,
            status: "unknown_outcome",
            summary:
              "Aroko cannot prove whether this change was fully applied. Human reconciliation required.",
            unknownOutcome: true,
            outputs: {
              actionType: "repository.edit",
              appliedCount: 0,
              journalPhase: "applying"
            },
            error: {
              code: "pairmesh.action_unknown_outcome",
              message: "Injected crash after journal applying; do not auto-retry."
            },
            executorInvocationCount: this.applyInvocationCount
          }
        };
      }

      try {
        const applyResult = await commitPatchApply(plan, {
          faultMode: this.faultMode,
          abortSignal: context.abortSignal,
          workspaceRoot
        });

        if (applyResult.partial) {
          await writeMutationJournal(actionsRoot, {
            actionId: execution.actionId,
            phase: "applied",
            workspaceRoot,
            paths: proposalPaths,
            appliedPaths: applyResult.appliedPaths,
            updatedAt: new Date().toISOString()
          });
          const allowPaths = resolveIncludeDiff(context, execution);
          return {
            result: buildPartialResult(
              execution,
              artifactRecord,
              applyResult.appliedPaths,
              allowPaths,
              this.applyInvocationCount
            )
          };
        }

        await writeMutationJournal(actionsRoot, {
          actionId: execution.actionId,
          phase: "applied",
          workspaceRoot,
          paths: proposalPaths,
          appliedPaths: applyResult.appliedPaths,
          updatedAt: new Date().toISOString()
        });

        if (this.faultMode === "after_writes_before_result") {
          // commitPatchApply already threw for this mode; defensive.
        }

        const allowPaths = resolveIncludeDiff(context, execution);
        const result = buildCompletedResult(
          execution,
          proposal,
          artifactRecord,
          applyResult,
          allowPaths,
          this.applyInvocationCount
        );
        await clearMutationJournal(actionsRoot, execution.actionId);
        return { result };
      } catch (error) {
        return {
          result: await mapApplyError(
            execution,
            artifactRecord,
            actionsRoot,
            proposalPaths,
            error,
            this.applyInvocationCount,
            context
          )
        };
      }
    });
  }
}

async function loadAndVerifyProposal(
  execution: ActionExecutionRecord,
  artifactStore: ActionArtifactStore,
  sessionState?: LocalSessionState
): Promise<{ proposal: ProposalArtifactV1; record: ActionArtifactRecord }> {
  const ref = execution.artifactRefs?.[0];
  if (!ref) {
    throw createPairMeshError({
      code: "pairmesh.artifact_not_found",
      message: "repository.edit requires an artifact reference."
    });
  }
  const record = (sessionState?.actionArtifacts ?? []).find(
    (entry) => entry.artifactId === ref.artifactId
  );
  if (!record) {
    throw createPairMeshError({
      code: "pairmesh.artifact_not_found",
      message: "Approved artifact record not found."
    });
  }
  if (record.contentHash !== ref.contentHash) {
    throw createPairMeshError({
      code: "pairmesh.artifact_hash_mismatch",
      message: "Artifact hash does not match the approved reference."
    });
  }
  if (
    execution.approvalBinding?.artifactId &&
    execution.approvalBinding.artifactId !== ref.artifactId
  ) {
    throw createPairMeshError({
      code: "pairmesh.action_binding_mismatch",
      message: "Artifact id does not match approval binding."
    });
  }
  if (
    execution.approvalBinding?.artifactContentHash &&
    execution.approvalBinding.artifactContentHash !== ref.contentHash
  ) {
    throw createPairMeshError({
      code: "pairmesh.action_binding_mismatch",
      message: "Artifact hash does not match approval binding."
    });
  }

  const bytes = await artifactStore.readBytes(record);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Proposal artifact is not valid JSON."
    });
  }
  const proposal = ProposalArtifactV1Schema.parse(parsed);
  if (proposal.format !== PROPOSAL_FORMAT_V1) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Unsupported proposal format."
    });
  }
  return { proposal, record };
}

function resolveIncludeDiff(
  context: ActionExecutorContext,
  execution: ActionExecutionRecord
): boolean {
  if (typeof context.includeDiffContent === "boolean") {
    return context.includeDiffContent;
  }
  if (context.sessionState) {
    return mayIncludeSourceReferences(context.sessionState, execution.requesterParticipantId);
  }
  return false;
}

function buildCompletedResult(
  execution: ActionExecutionRecord,
  proposal: ProposalArtifactV1,
  artifact: ActionArtifactRecord,
  applyResult: { appliedPaths: string[]; filesChanged: number; bytesChanged: number },
  includeDiffContent: boolean,
  invocationCount: number
): ActionResult {
  const outputs: Record<string, string | number | boolean | null> = {
    actionType: "repository.edit",
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    filesChanged: applyResult.filesChanged,
    bytesChanged: applyResult.bytesChanged,
    additions: proposal.stats.additions,
    deletions: proposal.stats.deletions,
    sourceReferencesAllowed: includeDiffContent
  };
  if (includeDiffContent) {
    outputs.appliedPaths = JSON.stringify(applyResult.appliedPaths);
    outputs.affectedPaths = JSON.stringify(proposal.affectedPaths);
  }
  return {
    actionId: execution.actionId,
    status: "completed",
    summary: `Applied proposal: ${proposal.summary}`.slice(0, 2000),
    artifactRefs: [
      {
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        artifactType: artifact.artifactType
      }
    ],
    outputs,
    executorInvocationCount: invocationCount,
    completedAt: new Date().toISOString()
  };
}

function buildPartialResult(
  execution: ActionExecutionRecord,
  artifact: ActionArtifactRecord,
  appliedPaths: string[],
  includeDiffContent: boolean,
  invocationCount: number
): ActionResult {
  const outputs: Record<string, string | number | boolean | null> = {
    actionType: "repository.edit",
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    filesChanged: appliedPaths.length,
    appliedCount: appliedPaths.length,
    sourceReferencesAllowed: includeDiffContent
  };
  if (includeDiffContent) {
    outputs.appliedPaths = JSON.stringify(appliedPaths);
  }
  return {
    actionId: execution.actionId,
    status: "partially_completed",
    summary: "repository.edit partially applied; no automatic retry.",
    partial: true,
    artifactRefs: [
      {
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        artifactType: artifact.artifactType
      }
    ],
    outputs,
    error: {
      code: "pairmesh.repository_apply_partial",
      message: "One or more files were applied before failure or cancellation."
    },
    executorInvocationCount: invocationCount,
    completedAt: new Date().toISOString()
  };
}

function cancelledResult(
  actionId: ActionExecutionRecord["actionId"],
  invocationCount: number,
  when: string
): ActionResult {
  return {
    actionId,
    status: "cancelled",
    summary: `repository.edit cancelled ${when}.`,
    executorInvocationCount: invocationCount
  };
}

async function mapApplyError(
  execution: ActionExecutionRecord,
  artifact: ActionArtifactRecord,
  actionsRoot: string,
  proposalPaths: string[],
  error: unknown,
  invocationCount: number,
  context: ActionExecutorContext
): Promise<ActionResult> {
  const appliedPaths =
    typeof error === "object" &&
    error !== null &&
    "appliedPaths" in error &&
    Array.isArray((error as { appliedPaths: unknown }).appliedPaths)
      ? (error as { appliedPaths: string[] }).appliedPaths
      : [];
  const writesCompleted =
    typeof error === "object" &&
    error !== null &&
    "writesCompleted" in error &&
    (error as { writesCompleted: unknown }).writesCompleted === true;

  if (
    writesCompleted ||
    (isCode(error, "pairmesh.action_unknown_outcome") && appliedPaths.length > 0)
  ) {
    await writeMutationJournal(actionsRoot, {
      actionId: execution.actionId,
      phase: "applied",
      workspaceRoot: context.workspaceRoot ?? "",
      paths: proposalPaths,
      appliedPaths,
      updatedAt: new Date().toISOString()
    });
    return {
      actionId: execution.actionId,
      status: "unknown_outcome",
      summary: "repository.edit writes may have completed; durable result uncertain.",
      unknownOutcome: true,
      artifactRefs: [
        {
          artifactId: artifact.artifactId,
          contentHash: artifact.contentHash,
          artifactType: artifact.artifactType
        }
      ],
      outputs: {
        actionType: "repository.edit",
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        appliedCount: appliedPaths.length
      },
      error: {
        code: "pairmesh.action_unknown_outcome",
        message: "Human reconciliation required; do not auto-retry."
      },
      executorInvocationCount: invocationCount
    };
  }

  if (appliedPaths.length > 0 || isCode(error, "pairmesh.repository_apply_partial")) {
    await writeMutationJournal(actionsRoot, {
      actionId: execution.actionId,
      phase: "applied",
      workspaceRoot: context.workspaceRoot ?? "",
      paths: proposalPaths,
      appliedPaths,
      updatedAt: new Date().toISOString()
    });
    return buildPartialResult(
      execution,
      artifact,
      appliedPaths,
      resolveIncludeDiff(context, execution),
      invocationCount
    );
  }

  await clearMutationJournal(actionsRoot, execution.actionId);
  return mapFailure(execution.actionId, error, invocationCount);
}

function mapFailure(
  actionId: ActionExecutionRecord["actionId"],
  error: unknown,
  invocationCount: number
): ActionResult {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("pairmesh.")
  ) {
    const code = (error as { code: string }).code;
    const message =
      "message" in error && typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : "repository.edit failed.";
    return {
      actionId,
      status: "failed",
      summary: message.slice(0, 2000),
      error: { code, message: message.slice(0, 500) },
      executorInvocationCount: invocationCount
    };
  }
  return {
    actionId,
    status: "failed",
    summary: "repository.edit failed.",
    error: {
      code: "pairmesh.repository_apply_failed",
      message: "repository.edit failed."
    },
    executorInvocationCount: invocationCount
  };
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
