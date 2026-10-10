import * as z from "zod";

/** Ambiguous characters (0/O, 1/I/L) excluded for readability. */
const SESSION_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const SessionCodeSchema = z
  .string()
  .regex(/^PM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, {
    message: "Session code must match PM-XXXXXX using uppercase unambiguous characters."
  })
  .brand<"SessionCode">();
export type SessionCode = z.infer<typeof SessionCodeSchema>;

export function generateSessionCode(randomBytes: Uint8Array): SessionCode {
  if (randomBytes.length < 6) {
    throw new Error("At least 6 random bytes required to generate a session code.");
  }

  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += SESSION_CODE_ALPHABET[randomBytes[i]! % SESSION_CODE_ALPHABET.length];
  }

  return SessionCodeSchema.parse(`PM-${suffix}`);
}
