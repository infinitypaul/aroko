import * as z from "zod";

export const IsoUtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), {
    message: "Timestamp must be an ISO-8601 UTC string ending with Z."
  });

export type IsoUtcTimestamp = z.infer<typeof IsoUtcTimestampSchema>;
