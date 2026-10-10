import * as z from "zod";
import { DeveloperIdSchema, DeviceIdSchema } from "./ids.js";

export const PairMeshDeviceSchema = z
  .strictObject({
    id: DeviceIdSchema,
    developerId: DeveloperIdSchema,
    name: z.string().trim().min(1).max(80),
    platform: z.string().trim().min(1).max(40).optional()
  })
  .describe("PairMesh device metadata.");
export type PairMeshDevice = z.infer<typeof PairMeshDeviceSchema>;
