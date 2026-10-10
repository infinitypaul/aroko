export { PROPOSAL_V1_LIMITS, type ProposalV1Limits } from "./limits.js";
export {
  normalizeProposalRelativePath,
  assertProposalPathInsideWorkspace,
  assertCommitPathConfined,
  isSensitiveRelativePath,
  SENSITIVE_PATH_SEGMENTS
} from "./paths.js";
export { parseAndNormalizeUnifiedDiff, type ParsedUnifiedDiff } from "./unified-diff.js";
export {
  PROPOSAL_FORMAT_V1,
  ProposalArtifactV1Schema,
  ProposalStatsSchema,
  buildCanonicalProposalBytes,
  hashProposalArtifact,
  type ProposalArtifactV1,
  type ProposalStats,
  type LocalProposalView
} from "./schema.js";
export type { ProposalGenerator, ProposalGenerateInput, RawProposalDraft } from "./generator.js";
export { CodingAgentProposalGenerator, StaticProposalGenerator } from "./coding-agent-generator.js";
export { digestWorkingTree } from "./working-tree.js";
