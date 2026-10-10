import * as z from "zod";

export const PairMeshA2AAgentRuntimeConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  skills: z.enum(["full", "echo-only"]).optional().default("full"),
  fakeAgentDelayMs: z.number().int().nonnegative().optional()
});
export type PairMeshA2AAgentRuntimeConfig = z.infer<typeof PairMeshA2AAgentRuntimeConfigSchema>;

export const SendToPeerInputSchema = z.strictObject({
  target: z.url(),
  message: z.string().trim().min(1).max(2_000),
    bearerToken: z.string().trim().min(1).max(200).optional()
});
export type SendToPeerInput = z.infer<typeof SendToPeerInputSchema>;
