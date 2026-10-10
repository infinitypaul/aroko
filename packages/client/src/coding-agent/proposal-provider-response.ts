import { createPairMeshError } from "@pairmesh/protocol";
import { PROPOSAL_V1_LIMITS } from "../action/proposal/limits.js";

export const PROVIDER_PROPOSAL_FORMAT_V1 = "pairmesh.proposal-provider.v1" as const;

export const PROPOSAL_PROVIDER_BEGIN = "<<<PAIRMESH_PROPOSAL_PROVIDER_V1>>>";
export const PROPOSAL_PROVIDER_END = "<<<END_PAIRMESH_PROPOSAL_PROVIDER_V1>>>";

export interface ProviderProposalFileV1 {
  path: string;
  /** Unified-diff body for this file (may include ---/+++/@@ hunks; optional diff --git header). */
  patch: string;
}

export interface ProviderProposalV1 {
  version: typeof PROVIDER_PROPOSAL_FORMAT_V1;
  summary: string;
  files: ProviderProposalFileV1[];
}

/**
 * Parse untrusted provider text into a structured proposal draft.
 * Accepts a fenced PairMesh block or a bare JSON object. Fail closed.
 */
export function parseProviderProposalResponse(rawText: string): ProviderProposalV1 {
  if (Buffer.byteLength(rawText, "utf8") > PROPOSAL_V1_LIMITS.maxUnifiedDiffBytes * 2) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Provider proposal response exceeds size limits."
    });
  }

  const extracted = extractProposalJson(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Provider proposal response is not valid JSON."
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Provider proposal JSON must be an object."
    });
  }

  const record = parsed as Record<string, unknown>;
  const version = record.version;
  if (version !== PROVIDER_PROPOSAL_FORMAT_V1) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: `Unsupported provider proposal version: ${String(version)}`
    });
  }

  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Provider proposal is missing a summary."
    });
  }

  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Provider proposal contains no file changes."
    });
  }
  if (record.files.length > PROPOSAL_V1_LIMITS.maxFiles) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: `Provider proposal exceeds max file count (${PROPOSAL_V1_LIMITS.maxFiles}).`
    });
  }

  const files: ProviderProposalFileV1[] = [];
  for (const entry of record.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: "Provider proposal file entry must be an object."
      });
    }
    const file = entry as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path.trim() : "";
    const patch = typeof file.patch === "string" ? file.patch.replace(/\r\n/g, "\n") : "";
    if (!path || !patch.trim()) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: "Provider proposal file entries require path and patch."
      });
    }
    if (Buffer.byteLength(patch, "utf8") > PROPOSAL_V1_LIMITS.maxPerFilePatchBytes) {
      throw createPairMeshError({
        code: "pairmesh.proposal_invalid",
        message: `Provider per-file patch exceeds receiver V1 limit for ${path}.`
      });
    }
    files.push({ path, patch });
  }

  return {
    version: PROVIDER_PROPOSAL_FORMAT_V1,
    summary: summary.slice(0, PROPOSAL_V1_LIMITS.maxSummaryChars),
    files
  };
}

/**
 * Convert structured provider files into a single unified-diff text for
 * PairMesh proposal validation / artifact storage.
 */
export function providerProposalToUnifiedDiff(proposal: ProviderProposalV1): string {
  const sections: string[] = [];
  for (const file of proposal.files) {
    sections.push(ensureFileDiffHeaders(file.path, file.patch));
  }
  const unified = sections.join("\n").replace(/\n*$/, "\n");
  if (Buffer.byteLength(unified, "utf8") > PROPOSAL_V1_LIMITS.maxUnifiedDiffBytes) {
    throw createPairMeshError({
      code: "pairmesh.proposal_invalid",
      message: "Assembled unified diff exceeds receiver V1 size limit."
    });
  }
  return unified;
}

function extractProposalJson(rawText: string): string {
  const begin = rawText.indexOf(PROPOSAL_PROVIDER_BEGIN);
  const end = rawText.indexOf(PROPOSAL_PROVIDER_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return rawText.slice(begin + PROPOSAL_PROVIDER_BEGIN.length, end).trim();
  }

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.includes(PROVIDER_PROPOSAL_FORMAT_V1) || candidate.trimStart().startsWith("{")) {
      return candidate;
    }
  }

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return rawText.slice(firstBrace, lastBrace + 1);
  }

  throw createPairMeshError({
    code: "pairmesh.proposal_invalid",
    message: "Provider response did not contain a structured proposal JSON object."
  });
}

function ensureFileDiffHeaders(path: string, patch: string): string {
  const normalized = patch.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const lines = normalized.split("\n");
  const hasGitHeader = lines.some((line) => line.startsWith("diff --git "));
  const hasMinus = lines.some((line) => line.startsWith("--- "));
  const hasPlus = lines.some((line) => line.startsWith("+++ "));
  const minusLine = lines.find((line) => line.startsWith("--- "));
  const plusLine = lines.find((line) => line.startsWith("+++ "));
  const minusIsDevNull = Boolean(minusLine?.includes("/dev/null"));
  const plusIsDevNull = Boolean(plusLine?.includes("/dev/null"));
  const renameFrom = lines.find((line) => line.startsWith("rename from "));
  const renameTo = lines.find((line) => line.startsWith("rename to "));
  const gitLine = lines.find((line) => line.startsWith("diff --git "));
  const gitMatch = gitLine ? /^diff --git a\/(.+) b\/(.+)$/.exec(gitLine) : null;
  const isRename =
    Boolean(renameFrom && renameTo) ||
    Boolean(gitMatch && gitMatch[1] !== gitMatch[2] && !minusIsDevNull && !plusIsDevNull);

  // Preserve authoritative /dev/null and rename headers from the provider patch.
  if (hasGitHeader && hasMinus && hasPlus) {
    return normalized;
  }

  const body: string[] = [];
  if (!hasGitHeader) {
    if (isRename && gitMatch) {
      body.push(`diff --git a/${gitMatch[1]} b/${gitMatch[2]}`);
    } else {
      body.push(`diff --git a/${path} b/${path}`);
    }
  }
  if (!hasMinus) {
    body.push(minusIsDevNull ? `--- /dev/null` : `--- a/${path}`);
  }
  if (!hasPlus) {
    body.push(plusIsDevNull ? `+++ /dev/null` : `+++ b/${path}`);
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (isRename && gitMatch) {
        body.push(`diff --git a/${gitMatch[1]} b/${gitMatch[2]}`);
      } else if (minusIsDevNull || plusIsDevNull) {
        body.push(`diff --git a/${path} b/${path}`);
      } else {
        body.push(`diff --git a/${path} b/${path}`);
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      body.push(line.includes("/dev/null") ? "--- /dev/null" : `--- a/${path}`);
      continue;
    }
    if (line.startsWith("+++ ")) {
      body.push(line.includes("/dev/null") ? "+++ /dev/null" : `+++ b/${path}`);
      continue;
    }
    body.push(line);
  }
  return body.join("\n");
}
