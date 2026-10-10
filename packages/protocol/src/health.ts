import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";

export const PairMeshRuntimeHealthStatusSchema = z.enum(["ready", "degraded", "unavailable"]);
export type PairMeshRuntimeHealthStatus = z.infer<typeof PairMeshRuntimeHealthStatusSchema>;

export const CodingAgentAvailabilityStatusSchema = z.enum([
  "configured",
  "available",
  "unavailable",
  "busy"
]);
export type CodingAgentAvailabilityStatus = z.infer<typeof CodingAgentAvailabilityStatusSchema>;

export const PairMeshRuntimeHealthAgentSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80)
  })
  .describe("Safe local PairMesh agent identity for health responses.");

export const PairMeshRuntimeHealthProjectSchema = z
  .strictObject({
    projectId: z.string().trim().min(1)
  })
  .describe("Safe local project identity for runtime verification.");

export const PairMeshRuntimeHealthCodingAgentSchema = z
  .strictObject({
    provider: z.string().trim().min(1).max(40),
    configured: z.boolean(),
    status: CodingAgentAvailabilityStatusSchema,
    reason: z.string().trim().min(1).max(200).optional()
  })
  .describe("Coding-agent readiness without exposing auth or workspace paths.");

export const PairMeshRuntimeHealthSchema = z
  .strictObject({
    status: PairMeshRuntimeHealthStatusSchema,
    agent: PairMeshRuntimeHealthAgentSchema,
    project: PairMeshRuntimeHealthProjectSchema.optional(),
    /**
     * Omitted for unauthenticated remote callers: coding-agent readiness is
     * operational detail that only paired peers and the local machine need.
     */
    codingAgent: PairMeshRuntimeHealthCodingAgentSchema.optional(),
    timestamp: IsoUtcTimestampSchema,
    readyForInspection: z.boolean()
  })
  .describe("PairMesh operational health — separate from A2A Agent Card discovery.");
export type PairMeshRuntimeHealth = z.infer<typeof PairMeshRuntimeHealthSchema>;

export const PeerHealthReachableSchema = z
  .strictObject({
    peer: z.string().trim().min(1).max(80),
    reachable: z.literal(true),
    pairmesh: z.strictObject({
      status: PairMeshRuntimeHealthStatusSchema
    }),
    codingAgent: z
      .strictObject({
        provider: z.string().trim().min(1).max(40),
        status: CodingAgentAvailabilityStatusSchema
      })
      .optional()
  })
  .describe("Peer health when the PairMesh agent responds to GET /health.");

export const PeerHealthUnreachableSchema = z
  .strictObject({
    peer: z.string().trim().min(1).max(80),
    reachable: z.literal(false),
    reason: z.string().trim().min(1).max(200).optional()
  })
  .describe("Peer health when the PairMesh agent cannot be reached.");

export const PeerHealthResultSchema = z.discriminatedUnion("reachable", [
  PeerHealthReachableSchema,
  PeerHealthUnreachableSchema
]);
export type PeerHealthResult = z.infer<typeof PeerHealthResultSchema>;
