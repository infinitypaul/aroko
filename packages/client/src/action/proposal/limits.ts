/**
 * Receiver-owned V1 limits for change.propose artifacts.
 * Requester parameters must never widen these.
 */
export const PROPOSAL_V1_LIMITS = {
  maxFiles: 40,
  maxArtifactBytes: 512 * 1024,
  maxPerFilePatchBytes: 128 * 1024,
  maxUnifiedDiffBytes: 480 * 1024,
  maxSummaryChars: 2000
} as const;

export type ProposalV1Limits = typeof PROPOSAL_V1_LIMITS;
