import {
  PAIRMESH_REDACTED,
  PAIRMESH_SECRET_BYTE_LENGTH,
  PairMeshBearerTokenSchema,
  PairMeshInviteSecretSchema,
  PairMeshSecretHashSchema,
  type PairMeshBearerToken,
  type PairMeshInviteSecret,
  type PairMeshSecretHash
} from "@pairmesh/protocol";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function generateOpaqueSecret(): string {
  return randomBytes(PAIRMESH_SECRET_BYTE_LENGTH).toString("base64url");
}

/** Generates a single-use, 256-bit invite secret. Never persisted in plaintext. */
export function generateInviteSecret(): PairMeshInviteSecret {
  return PairMeshInviteSecretSchema.parse(generateOpaqueSecret());
}

/** Generates a 256-bit opaque session bearer token for one direction of one pair. */
export function generateBearerToken(): PairMeshBearerToken {
  return PairMeshBearerTokenSchema.parse(generateOpaqueSecret());
}

export function hashSecret(secret: string): PairMeshSecretHash {
  return PairMeshSecretHashSchema.parse(createHash("sha256").update(secret, "utf8").digest("hex"));
}

/** Constant-time comparison of two SHA-256 hex digests. */
export function secretHashesEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Constant-time check that a presented secret hashes to a stored digest. */
export function secretMatchesHash(secret: string, hash: string): boolean {
  return secretHashesEqual(hashSecret(secret), hash);
}

/** Replaces any secret with a fixed marker so it can never reach logs or output. */
export function redactSecret(value: string | undefined): string {
  return value === undefined || value.length === 0 ? "" : PAIRMESH_REDACTED;
}

/**
 * Short, non-reversible label for a credential, safe for status output. Derived
 * from the stored hash so it never requires access to the secret itself.
 */
export function credentialFingerprint(tokenHash: string): string {
  return tokenHash.slice(0, 8);
}
