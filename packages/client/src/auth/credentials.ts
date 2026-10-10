import {
  CredentialIdSchema,
  IsoUtcTimestampSchema,
  PairMeshAcceptedInboundCredentialSchema,
  type PairMeshAcceptedInboundCredential,
  type PairMeshBearerToken,
  type PairMeshSessionSecurity
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { generateBearerToken, hashSecret, secretHashesEqual } from "./secrets.js";

export interface IssuedInboundCredential {
  credential: PairMeshAcceptedInboundCredential;
  /** Plaintext token handed to the peer once. Only its hash is persisted. */
  token: PairMeshBearerToken;
}

/**
 * Mints the bearer token this agent will accept from `participantId` on inbound
 * calls. The plaintext is returned to the caller for one-time delivery.
 */
export function issueInboundCredential(
  participantId: string,
  now: Date = new Date()
): IssuedInboundCredential {
  const token = generateBearerToken();
  return { credential: registerInboundCredential(participantId, token, now), token };
}

/**
 * Builds the accepted-inbound record for a token this agent generated earlier
 * (for example the bearer a joiner offers the creator during the handshake).
 */
export function registerInboundCredential(
  participantId: string,
  token: string,
  now: Date = new Date()
): PairMeshAcceptedInboundCredential {
  return PairMeshAcceptedInboundCredentialSchema.parse({
    participantId,
    credentialId: CredentialIdSchema.parse(`cred_${randomUUID()}`),
    tokenHash: hashSecret(token),
    issuedAt: IsoUtcTimestampSchema.parse(now.toISOString())
  });
}

/**
 * Resolves the participant a presented bearer token authenticates. Compares
 * every stored hash so lookup cost does not depend on which entry matches.
 */
export function resolveInboundCredential(
  security: PairMeshSessionSecurity,
  presentedToken: string
): PairMeshAcceptedInboundCredential | undefined {
  const presentedHash = hashSecret(presentedToken);
  let matched: PairMeshAcceptedInboundCredential | undefined;

  for (const credential of security.acceptedInbound) {
    if (secretHashesEqual(presentedHash, credential.tokenHash)) {
      matched = credential;
    }
  }

  return matched?.revokedAt === undefined ? matched : undefined;
}

export function revokeInboundCredentials(
  security: PairMeshSessionSecurity,
  participantId: string,
  now: Date = new Date()
): PairMeshSessionSecurity {
  const revokedAt = IsoUtcTimestampSchema.parse(now.toISOString());
  return {
    ...security,
    acceptedInbound: security.acceptedInbound.map((credential) =>
      credential.participantId === participantId && credential.revokedAt === undefined
        ? { ...credential, revokedAt }
        : credential
    )
  };
}

export function revokeAllInboundCredentials(
  security: PairMeshSessionSecurity,
  now: Date = new Date()
): PairMeshSessionSecurity {
  const revokedAt = IsoUtcTimestampSchema.parse(now.toISOString());
  return {
    ...security,
    acceptedInbound: security.acceptedInbound.map((credential) =>
      credential.revokedAt === undefined ? { ...credential, revokedAt } : credential
    )
  };
}
