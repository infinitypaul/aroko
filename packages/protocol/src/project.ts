import * as z from "zod";
import { ProjectIdSchema } from "./ids.js";

const RepositoryHintSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/, {
    message: "Repository hint must be a safe label (for example owner/repo)."
  });

export const PairMeshProjectSchema = z
  .strictObject({
    id: ProjectIdSchema,
    name: z.string().trim().min(1).max(120),
    repositoryHint: RepositoryHintSchema.optional()
  })
  .describe("Shared project metadata. Absolute local filesystem paths are intentionally excluded.");
export type PairMeshProject = z.infer<typeof PairMeshProjectSchema>;
