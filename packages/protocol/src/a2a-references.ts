import * as z from "zod";

/**
 * A2A references only. PairMesh does not redefine A2A objects.
 */
export const A2AAgentReferenceSchema = z.strictObject({
  a2aAgentCardUrl: z.url()
});
export type A2AAgentReference = z.infer<typeof A2AAgentReferenceSchema>;

export const A2ATaskReferenceSchema = z.strictObject({
  a2aTaskId: z.string().trim().min(1).max(256),
  agent: A2AAgentReferenceSchema.optional()
});
export type A2ATaskReference = z.infer<typeof A2ATaskReferenceSchema>;
