import * as z from "zod";
import { PAIRMESH_METADATA_VERSION } from "../version.js";
import { PairMeshErrorSchema, type PairMeshError, type PairMeshValidationIssue } from "./schema.js";

export type PairMeshParseResult<T> = { ok: true; value: T } | { ok: false; error: PairMeshError };

function safeValidationIssues(issues: z.core.$ZodIssue[]): PairMeshValidationIssue[] {
  return issues.slice(0, 25).map((issue) => ({
    path: (issue.path ?? []).filter((segment): segment is string | number => {
      return typeof segment === "string" || typeof segment === "number";
    }),
    message: issue.message,
    code: issue.code
  }));
}

export function createPairMeshError(error: PairMeshError): PairMeshError {
  return PairMeshErrorSchema.parse(error);
}

export function validatePairMeshMetadataVersion(version: unknown): PairMeshParseResult<"0.1.0"> {
  if (typeof version !== "string") {
    return {
      ok: false,
      error: createPairMeshError({
        code: "pairmesh.invalid_metadata",
        message: "Invalid PairMesh metadata: metadataVersion must be a string.",
        details: { field: "metadataVersion" }
      })
    };
  }

  if (version !== PAIRMESH_METADATA_VERSION) {
    return {
      ok: false,
      error: createPairMeshError({
        code: "pairmesh.unsupported_metadata_version",
        message: "Unsupported PairMesh metadata version.",
        metadataVersion: PAIRMESH_METADATA_VERSION,
        details: {
          expectedVersion: PAIRMESH_METADATA_VERSION,
          receivedVersion: version
        }
      })
    };
  }

  return { ok: true, value: PAIRMESH_METADATA_VERSION };
}

export function parsePairMeshMetadata<T>(
  schema: z.ZodType<T>,
  input: unknown
): PairMeshParseResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  return {
    ok: false,
    error: createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message: "Invalid PairMesh metadata payload.",
      issues: safeValidationIssues(parsed.error.issues)
    })
  };
}
