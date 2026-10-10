import type { ActionId, PeerId } from "@pairmesh/protocol";
import type { ProviderActivityEvent } from "../../coding-agent/provider-visibility.js";

export interface ProposalGenerateInput {
  actionId: ActionId;
  requesterParticipantId: PeerId;
  targetParticipantId: PeerId;
  /** Human instruction from the requester (untrusted). */
  instruction: string;
  workspaceRoot: string;
  abortSignal?: AbortSignal;
  onProviderActivity?: (event: ProviderActivityEvent) => void;
}

export interface RawProposalDraft {
  summary: string;
  unifiedDiff: string;
  providerId: string;
  providerMetadata?: Record<string, string | number | boolean | null>;
}

export interface ProposalGenerator {
  readonly id: string;
  generate(input: ProposalGenerateInput): Promise<RawProposalDraft>;
}
