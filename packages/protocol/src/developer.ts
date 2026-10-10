import * as z from "zod";
import { DeveloperIdSchema } from "./ids.js";

export const DeveloperHandleSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: "Handle must be lowercase alphanumeric with optional internal hyphens."
  });
export type DeveloperHandle = z.infer<typeof DeveloperHandleSchema>;

export const PairMeshDeveloperSchema = z
  .strictObject({
    id: DeveloperIdSchema,
    displayName: z.string().trim().min(1).max(80),
    handle: DeveloperHandleSchema.optional()
  })
  .describe("PairMesh developer metadata.");
export type PairMeshDeveloper = z.infer<typeof PairMeshDeveloperSchema>;
