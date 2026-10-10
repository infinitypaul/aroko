import { createPairMeshError } from "@pairmesh/protocol";
import {
  createCodingAgentError,
  isCodingAgentError,
  type CodingAgentAdapter
} from "../../coding-agent/types.js";
import type { ProposalGenerateInput, ProposalGenerator, RawProposalDraft } from "./generator.js";

/**
 * Wraps a coding-agent adapter's proposal-only path.
 * Never enables write/shell modes; adapters that cannot propose safely fail closed.
 */
export class CodingAgentProposalGenerator implements ProposalGenerator {
  public readonly id = "coding-agent-proposal-generator";
  private readonly adapter: CodingAgentAdapter;

  public constructor(adapter: CodingAgentAdapter) {
    this.adapter = adapter;
  }

  public async generate(input: ProposalGenerateInput): Promise<RawProposalDraft> {
    // Prefer invoke when proposeChange exists (LazyCodingAgentAdapter always
    // exposes a forwarder). Capability gating happens on the resolved provider.
    if (typeof this.adapter.proposeChange === "function") {
      try {
        const result = await this.adapter.proposeChange(
          {
            instruction: input.instruction,
            requestId: input.actionId,
            actionId: input.actionId
          },
          {
            signal: input.abortSignal,
            onProviderActivity: input.onProviderActivity
          }
        );
        return {
          summary: result.summary,
          unifiedDiff: result.unifiedDiff,
          providerId: this.adapter.provider.id,
          providerMetadata: result.providerMetadata
        };
      } catch (error) {
        if (isCodingAgentError(error)) {
          throw createCodingAgentError(error.code, error.message, error.details);
        }
        throw error;
      }
    }

    if (!this.adapter.provider.capabilities.proposeChange) {
      throw createPairMeshError({
        code: "pairmesh.proposal_unsupported",
        message: `Provider ${this.adapter.provider.id} does not support proposal-only generation.`
      });
    }

    throw createPairMeshError({
      code: "pairmesh.proposal_unsupported",
      message: `Provider ${this.adapter.provider.id} has no proposeChange implementation.`
    });
  }
}

/** Deterministic generator for unit tests (no coding agent). */
export class StaticProposalGenerator implements ProposalGenerator {
  public readonly id = "static-proposal-generator";
  private readonly draft: RawProposalDraft | (() => RawProposalDraft | Promise<RawProposalDraft>);
  public invocationCount = 0;

  public constructor(
    draft: RawProposalDraft | (() => RawProposalDraft | Promise<RawProposalDraft>)
  ) {
    this.draft = draft;
  }

  public async generate(_input: ProposalGenerateInput): Promise<RawProposalDraft> {
    void _input;
    this.invocationCount += 1;
    return typeof this.draft === "function" ? await this.draft() : this.draft;
  }
}
