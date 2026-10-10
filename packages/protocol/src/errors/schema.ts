import * as z from "zod";
import { PairMeshMetadataVersionSchema } from "../version.js";
import { PairMeshErrorCodeSchema } from "./codes.js";

const ABSOLUTE_PATH_PATTERN = /^(\/|~\/|[a-zA-Z]:\\)/;

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
);

function containsSensitiveShape(value: JsonValue): boolean {
  if (typeof value === "string") {
    return ABSOLUTE_PATH_PATTERN.test(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveShape(item));
  }
  return Object.entries(value).some(([key, nestedValue]) => {
    if (key.toLowerCase() === "stack" || key.toLowerCase() === "stacktrace") {
      return true;
    }
    return containsSensitiveShape(nestedValue);
  });
}

export const PairMeshErrorDetailsSchema = JsonValueSchema.refine(
  (value) => !containsSensitiveShape(value),
  {
    message: "Error details contain sensitive fields or absolute local paths."
  }
);
export type PairMeshErrorDetails = z.infer<typeof PairMeshErrorDetailsSchema>;

export const PairMeshValidationIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string()
});
export type PairMeshValidationIssue = z.infer<typeof PairMeshValidationIssueSchema>;

export const PairMeshErrorSchema = z.strictObject({
  code: PairMeshErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
  metadataVersion: PairMeshMetadataVersionSchema.optional(),
  correlationId: z.string().trim().min(1).max(128).optional(),
  details: PairMeshErrorDetailsSchema.optional(),
  issues: z.array(PairMeshValidationIssueSchema).max(25).optional()
});
export type PairMeshError = z.infer<typeof PairMeshErrorSchema>;
