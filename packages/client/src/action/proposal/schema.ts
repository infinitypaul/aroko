import * as z from "zod";
import { ActionIdSchema, IsoUtcTimestampSchema, PeerIdSchema } from "@pairmesh/protocol";
import { canonicalizeForDigest, sha256Hex } from "../digest.js";
import { PROPOSAL_V1_LIMITS } from "./limits.js";

export const PROPOSAL_FORMAT_V1 = "pairmesh.proposal.v1" as const;

export const ProposalStatsSchema = z.strictObject({
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative()
});
export type ProposalStats = z.infer<typeof ProposalStatsSchema>;

/**
 * Canonical proposal artifact body (`pairmesh.proposal.v1`).
 *
 * `artifactId` is owned by `ActionArtifactRecord` / `ActionArtifactRef` and is
 * injected when reading via local APIs — it is intentionally omitted from the
 * hashed body so storage can assign ids atomically.
 *
 * Canonicalization for hashing:
 * - UTF-8 JSON via `canonicalizeForDigest` (recursively sorted object keys)
 * - `affectedPaths` sorted lexicographically before serialization
 * - `unifiedDiff` path-normalized with file sections sorted by relative path
 * - no absolute paths, tokens, credentials, or environment values
 */
export const ProposalArtifactV1Schema = z.strictObject({
  format: z.literal(PROPOSAL_FORMAT_V1),
  actionId: ActionIdSchema,
  requesterParticipantId: PeerIdSchema,
  targetParticipantId: PeerIdSchema,
  createdAt: IsoUtcTimestampSchema,
  summary: z.string().trim().min(1).max(PROPOSAL_V1_LIMITS.maxSummaryChars),
  affectedPaths: z.array(z.string().trim().min(1).max(500)).max(PROPOSAL_V1_LIMITS.maxFiles),
  unifiedDiff: z.string().min(1),
  stats: ProposalStatsSchema,
  provider: z
    .strictObject({
      id: z.string().trim().min(1).max(80),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
    })
    .optional()
});
export type ProposalArtifactV1 = z.infer<typeof ProposalArtifactV1Schema>;

export interface LocalProposalView extends ProposalArtifactV1 {
  artifactId: string;
  contentHash: string;
  byteSize: number;
}

export function buildCanonicalProposalBytes(proposal: ProposalArtifactV1): Buffer {
  const parsed = ProposalArtifactV1Schema.parse(proposal);
  const forHash = {
    ...parsed,
    affectedPaths: [...parsed.affectedPaths].sort()
  };
  return Buffer.from(canonicalizeForDigest(forHash), "utf8");
}

export function hashProposalArtifact(proposal: ProposalArtifactV1): string {
  return sha256Hex(buildCanonicalProposalBytes(proposal));
}
