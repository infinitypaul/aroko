import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import {
  InspectionThreadIdSchema,
  InspectionTurnIdSchema,
  PeerIdSchema,
  SessionIdSchema
} from "./ids.js";
import { PairMeshSourceReferenceListSchema } from "./source-reference.js";
import { PairMeshMetadataVersionSchema } from "./version.js";

export const InspectionThreadStatusSchema = z.enum(["active", "closed"]);
export type InspectionThreadStatus = z.infer<typeof InspectionThreadStatusSchema>;

export const PairMeshInspectionThreadSchema = z
  .strictObject({
    id: InspectionThreadIdSchema,
    sessionId: SessionIdSchema,
    initiatorPeerId: PeerIdSchema,
    targetPeerId: PeerIdSchema,
    status: InspectionThreadStatusSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    topic: z.string().trim().min(1).max(200).optional()
  })
  .describe("PairMesh cross-developer inspection thread metadata.");
export type PairMeshInspectionThread = z.infer<typeof PairMeshInspectionThreadSchema>;

export const PairMeshInspectionTurnSchema = z
  .strictObject({
    id: InspectionTurnIdSchema,
    threadId: InspectionThreadIdSchema,
    requestId: z.string().trim().min(1).max(80),
    question: z.string().trim().min(1).max(4000),
    createdAt: IsoUtcTimestampSchema
  })
  .describe("Single turn within a PairMesh inspection thread.");
export type PairMeshInspectionTurn = z.infer<typeof PairMeshInspectionTurnSchema>;

const PairMeshInspectionTurnResultBaseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    requestId: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(4000),
    findings: z.array(z.string().trim().min(1).max(2000)).max(50),
    references: PairMeshSourceReferenceListSchema
  })
  .describe("Sanitized inspection turn result safe for PairMesh sharing.");

export const PairMeshInspectionTurnResultSchema = z.preprocess((value) => {
  if (typeof value === "object" && value !== null && !("references" in value)) {
    return { ...(value as Record<string, unknown>), references: [] };
  }
  return value;
}, PairMeshInspectionTurnResultBaseSchema);
export type PairMeshInspectionTurnResult = z.infer<typeof PairMeshInspectionTurnResultBaseSchema>;
