import * as z from "zod";

/**
 * Version for PairMesh-owned metadata schemas only.
 * This does not represent an A2A protocol version.
 */
export const PAIRMESH_METADATA_VERSION = "0.1.0" as const;

export const PairMeshMetadataVersionSchema = z.literal(PAIRMESH_METADATA_VERSION);
export type PairMeshMetadataVersion = z.infer<typeof PairMeshMetadataVersionSchema>;

export const PROTOCOL_INVARIANTS = {
  a2aIsNativeInterAgentProtocol: true,
  mcpIsClientBoundary: true,
  noProprietaryTaskMessageSemantics: true,
  pairmeshSessionIsNotA2aTask: true
} as const;
