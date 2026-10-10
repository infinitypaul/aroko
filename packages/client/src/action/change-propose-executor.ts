import {
  createPairMeshError,
  type ActionArtifactRecord,
  type ActionExecutionRecord,
  type ActionResult
} from "@pairmesh/protocol";
import { mayIncludeSourceReferences } from "../auth/capabilities.js";
import type { LocalSessionState } from "../session/schemas.js";
import type { ActionArtifactStore } from "./artifacts.js";
import type { ActionExecutor, ActionExecutorContext, ActionExecutorOutcome } from "./executor.js";
import type { ProposalGenerator } from "./proposal/generator.js";
import { PROPOSAL_V1_LIMITS } from "./proposal/limits.js";
import {
  PROPOSAL_FORMAT_V1,
  ProposalArtifactV1Schema,
  buildCanonicalProposalBytes,
  type ProposalArtifactV1
} from "./proposal/schema.js";
import { parseAndNormalizeUnifiedDiff } from "./proposal/unified-diff.js";

export interface ChangeProposeExecutorOptions {
  generator: ProposalGenerator;
  artifactStore: ActionArtifactStore;
  workspaceRoot: string;
  /**
   * When omitted, path/diff disclosure follows `repository.source_references`
   * for the requester on the session state snapshot.
   */
  includeDiffContent?: boolean;
  sessionState?: LocalSessionState;
}

export interface ChangeProposeExecutorContext extends ActionExecutorContext {
  workspaceRoot?: string;
  artifactStore?: ActionArtifactStore;
  includeDiffContent?: boolean;
  sessionState?: LocalSessionState;
}

export class ChangeProposeExecutor implements ActionExecutor {
  public readonly id = "change-propose-executor";
  public invocationCount = 0;
  private readonly generator: ProposalGenerator;
  private readonly artifactStore: ActionArtifactStore;
  private readonly workspaceRoot: string;
  private readonly includeDiffContent?: boolean;
  private readonly sessionState?: LocalSessionState;

  public constructor(options: ChangeProposeExecutorOptions) {
    this.generator = options.generator;
    this.artifactStore = options.artifactStore;
    this.workspaceRoot = options.workspaceRoot;
    this.includeDiffContent = options.includeDiffContent;
    this.sessionState = options.sessionState;
  }

  public async execute(
    execution: ActionExecutionRecord,
    context: ChangeProposeExecutorContext
  ): Promise<ActionExecutorOutcome> {
    this.invocationCount += 1;
    if (context.abortSignal?.aborted) {
      return {
        result: {
          actionId: execution.actionId,
          status: "cancelled",
          summary: "change.propose cancelled before provider start.",
          executorInvocationCount: this.invocationCount
        }
      };
    }

    const workspaceRoot = context.workspaceRoot ?? this.workspaceRoot;
    const artifactStore = context.artifactStore ?? this.artifactStore;
    let instruction: string;
    try {
      instruction = extractInstruction(execution);
    } catch (error) {
      return { result: mapGeneratorFailure(execution.actionId, error, this.invocationCount) };
    }

    let draft;
    try {
      draft = await this.generator.generate({
        actionId: execution.actionId,
        requesterParticipantId: execution.requesterParticipantId,
        targetParticipantId: execution.targetParticipantId,
        instruction,
        workspaceRoot,
        abortSignal: context.abortSignal,
        onProviderActivity: context.onProviderActivity
      });
    } catch (error) {
      return { result: mapGeneratorFailure(execution.actionId, error, this.invocationCount) };
    }

    if (context.abortSignal?.aborted) {
      return {
        result: {
          actionId: execution.actionId,
          status: "cancelled",
          summary: "change.propose cancelled after provider return.",
          executorInvocationCount: this.invocationCount
        }
      };
    }

    let parsed;
    try {
      parsed = await parseAndNormalizeUnifiedDiff(draft.unifiedDiff, workspaceRoot);
    } catch (error) {
      return { result: mapGeneratorFailure(execution.actionId, error, this.invocationCount) };
    }

    const proposalBody: ProposalArtifactV1 = ProposalArtifactV1Schema.parse({
      format: PROPOSAL_FORMAT_V1,
      actionId: execution.actionId,
      requesterParticipantId: execution.requesterParticipantId,
      targetParticipantId: execution.targetParticipantId,
      createdAt: new Date().toISOString(),
      summary: draft.summary.trim().slice(0, PROPOSAL_V1_LIMITS.maxSummaryChars),
      affectedPaths: parsed.affectedPaths,
      unifiedDiff: parsed.normalizedDiff,
      stats: {
        filesChanged: parsed.files.length,
        additions: parsed.additions,
        deletions: parsed.deletions
      },
      provider: {
        id: draft.providerId,
        ...(draft.providerMetadata ? { metadata: draft.providerMetadata } : {})
      }
    });

    const bytes = buildCanonicalProposalBytes(proposalBody);
    if (bytes.byteLength > PROPOSAL_V1_LIMITS.maxArtifactBytes) {
      return {
        result: {
          actionId: execution.actionId,
          status: "failed",
          summary: "Proposal artifact exceeds receiver V1 size limit.",
          error: {
            code: "pairmesh.proposal_invalid",
            message: "Proposal artifact exceeds receiver V1 size limit."
          },
          executorInvocationCount: this.invocationCount
        }
      };
    }

    const artifact = await artifactStore.createFinalizedArtifact({
      actionId: execution.actionId,
      artifactType: "patch_diff",
      bytes,
      metadata: {
        format: PROPOSAL_FORMAT_V1,
        filesChanged: proposalBody.stats.filesChanged,
        providerId: draft.providerId
      }
    });

    const allowDiff = this.resolveIncludeDiff(context, execution);
    return {
      result: buildSafeResult(execution, proposalBody, artifact, allowDiff, this.invocationCount),
      artifacts: [artifact]
    };
  }

  private resolveIncludeDiff(
    context: ChangeProposeExecutorContext,
    execution: ActionExecutionRecord
  ): boolean {
    if (typeof context.includeDiffContent === "boolean") {
      return context.includeDiffContent;
    }
    if (typeof this.includeDiffContent === "boolean") {
      return this.includeDiffContent;
    }
    const state = context.sessionState ?? this.sessionState;
    if (state) {
      return mayIncludeSourceReferences(state, execution.requesterParticipantId);
    }
    return false;
  }
}

function extractInstruction(execution: ActionExecutionRecord): string {
  const parameters = execution.parameters ?? {};
  const candidates = [
    parameters.instruction,
    parameters.question,
    parameters.prompt,
    parameters.summary
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  throw createPairMeshError({
    code: "pairmesh.proposal_invalid",
    message: "change.propose requires an instruction parameter."
  });
}

function buildSafeResult(
  execution: ActionExecutionRecord,
  proposal: ProposalArtifactV1,
  artifact: ActionArtifactRecord,
  includeDiffContent: boolean,
  invocationCount: number
): ActionResult {
  const outputs: Record<string, string | number | boolean | null> = {
    actionType: "change.propose",
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    filesChanged: proposal.stats.filesChanged,
    additions: proposal.stats.additions,
    deletions: proposal.stats.deletions,
    proposalFormat: PROPOSAL_FORMAT_V1,
    sourceReferencesAllowed: includeDiffContent
  };

  if (includeDiffContent) {
    outputs.affectedPaths = JSON.stringify(proposal.affectedPaths);
    outputs.unifiedDiff = proposal.unifiedDiff;
  }

  return {
    actionId: execution.actionId,
    status: "completed",
    summary: proposal.summary,
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

function mapGeneratorFailure(
  actionId: ActionExecutionRecord["actionId"],
  error: unknown,
  invocationCount: number
): ActionResult {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    const message =
      "message" in error && typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Proposal generation failed.";
    if (code.startsWith("pairmesh.")) {
      return {
        actionId,
        status: "failed",
        summary: message,
        error: { code, message: message.slice(0, 500) },
        executorInvocationCount: invocationCount
      };
    }
    if (code === "agent_misconfigured" || code === "agent_unavailable") {
      return {
        actionId,
        status: "failed",
        summary: message,
        error: {
          code: "pairmesh.proposal_unsupported",
          message: message.slice(0, 500)
        },
        executorInvocationCount: invocationCount
      };
    }
  }
  return {
    actionId,
    status: "failed",
    summary: "Proposal generation failed.",
    error: {
      code: "pairmesh.internal_error",
      message: "Proposal generation failed."
    },
    executorInvocationCount: invocationCount
  };
}
