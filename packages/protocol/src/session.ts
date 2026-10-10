import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import { AgentIdSchema, DeveloperIdSchema, PeerIdSchema, SessionIdSchema } from "./ids.js";

export const PairMeshSessionStatusSchema = z.enum(["active", "closed"]);
export type PairMeshSessionStatus = z.infer<typeof PairMeshSessionStatusSchema>;

export const PairMeshSessionSchema = z
  .strictObject({
    id: SessionIdSchema,
    createdBy: DeveloperIdSchema,
    createdAt: IsoUtcTimestampSchema,
    status: PairMeshSessionStatusSchema
  })
  .describe(
    "PairMesh collaboration session metadata (developer collaboration scope, not an A2A Task)."
  );
export type PairMeshSession = z.infer<typeof PairMeshSessionSchema>;

export const PairMeshSessionParticipantSchema = z
  .strictObject({
    id: PeerIdSchema,
    sessionId: SessionIdSchema,
    developerId: DeveloperIdSchema,
    agentId: AgentIdSchema,
    joinedAt: IsoUtcTimestampSchema
  })
  .describe("PairMesh session participant metadata.");
export type PairMeshSessionParticipant = z.infer<typeof PairMeshSessionParticipantSchema>;
