import { randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque control-plane token for localhost admin callers (extension host / CLI). */
export function generateControlToken(): string {
  return randomBytes(32).toString("base64url");
}

export function controlTokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
