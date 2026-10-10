import * as z from "zod";

/** Repository-relative source evidence from a remote peer's workspace — no file contents. */
export const PairMeshSourceReferenceKindSchema = z.enum([
  "file",
  "function",
  "method",
  "class",
  "type",
  "interface",
  "variable",
  "module",
  "other"
]);
export type PairMeshSourceReferenceKind = z.infer<typeof PairMeshSourceReferenceKindSchema>;

const REPO_RELATIVE_FILE_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9._\-/]+(\.[A-Za-z0-9]+)?$/;

export const PairMeshSourceReferenceSchema = z
  .strictObject({
    file: z.string().trim().min(1).max(500).regex(REPO_RELATIVE_FILE_PATTERN, {
      message: "Expected a repository-relative file path without traversal or absolute prefixes."
    }),
    symbol: z.string().trim().min(1).max(200).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    kind: PairMeshSourceReferenceKindSchema.optional()
  })
  .refine(
    (value) =>
      value.endLine === undefined ||
      value.startLine === undefined ||
      value.endLine >= value.startLine,
    { message: "endLine must be greater than or equal to startLine." }
  )
  .describe(
    "Sanitized repository-relative source reference. Describes the remote peer workspace, not the sender's."
  );
export type PairMeshSourceReference = z.infer<typeof PairMeshSourceReferenceSchema>;

export const PairMeshSourceReferenceListSchema = z
  .array(PairMeshSourceReferenceSchema)
  .max(50)
  .default([]);
