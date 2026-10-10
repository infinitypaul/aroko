import * as z from "zod";
import { AgentIdSchema, DeveloperIdSchema, DeviceIdSchema, ProjectIdSchema } from "./ids.js";

export const AdapterIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/, {
    message: "Adapter ID must be lowercase and dot-namespace friendly."
  });
export type AdapterId = z.infer<typeof AdapterIdSchema>;

export const PairMeshAgentSchema = z
  .strictObject({
    id: AgentIdSchema,
    developerId: DeveloperIdSchema,
    deviceId: DeviceIdSchema,
    projectId: ProjectIdSchema,
    name: z.string().trim().min(1).max(80),
    adapter: AdapterIdSchema,
    a2aAgentCardUrl: z.url().optional()
  })
  .describe("PairMesh agent identity/reference metadata. Not an A2A Agent Card replacement.");
export type PairMeshAgent = z.infer<typeof PairMeshAgentSchema>;
