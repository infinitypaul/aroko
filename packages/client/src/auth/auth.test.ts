import { PAIRMESH_INVITE_TTL_MS, PAIRMESH_REDACTED, PeerIdSchema } from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBearerFetch, formatBearerHeader, parseBearerHeader } from "./bearer.js";
import {
  issueInboundCredential,
  registerInboundCredential,
  resolveInboundCredential,
  revokeAllInboundCredentials,
  revokeInboundCredentials
} from "./credentials.js";
import {
  createInvite,
  markInviteUsed,
  revokeOpenInvites,
  validateInviteSecret
} from "./invites.js";
import {
  credentialFingerprint,
  generateBearerToken,
  generateInviteSecret,
  hashSecret,
  redactSecret,
  secretMatchesHash
} from "./secrets.js";
import { createSessionSecurity } from "./session-security.js";

function peerId(): string {
  return PeerIdSchema.parse(`peer_${randomUUID()}`);
}

describe("invite secrets", () => {
  it("generates high-entropy single-use secrets that are never stored in plaintext", () => {
    const invite = createInvite();
    const secrets = new Set([invite.secret]);
    for (let i = 0; i < 100; i += 1) {
      secrets.add(generateInviteSecret());
    }

    // 32 random bytes encode to 43 base64url characters.
    expect(invite.secret).toHaveLength(43);
    expect(secrets.size).toBe(101);
    expect(invite.record.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.record.secretHash).not.toContain(invite.secret);
    expect(secretMatchesHash(invite.secret, invite.record.secretHash)).toBe(true);
  });

  it("defaults to a 15 minute time to live", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const invite = createInvite({ now });
    expect(PAIRMESH_INVITE_TTL_MS).toBe(15 * 60 * 1000);
    expect(Date.parse(invite.record.expiresAt) - now.getTime()).toBe(PAIRMESH_INVITE_TTL_MS);
  });

  it("accepts the matching secret and rejects a wrong one", () => {
    const invite = createInvite();
    const security = { ...createSessionSecurity(), invites: [invite.record] };

    expect(validateInviteSecret(security, invite.secret).ok).toBe(true);

    const wrong = validateInviteSecret(security, generateInviteSecret());
    expect(wrong).toMatchObject({ ok: false, code: "pairmesh.invite_invalid" });
  });

  it("rejects an expired invite", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const invite = createInvite({ now, ttlMs: 1_000 });
    const security = { ...createSessionSecurity(), invites: [invite.record] };

    const result = validateInviteSecret(security, invite.secret, new Date(now.getTime() + 2_000));
    expect(result).toMatchObject({ ok: false, code: "pairmesh.invite_expired" });
  });

  it("rejects a second redemption of the same invite", () => {
    const invite = createInvite();
    const security = { ...createSessionSecurity(), invites: [invite.record] };

    const first = validateInviteSecret(security, invite.secret);
    expect(first.ok).toBe(true);

    const used = markInviteUsed(security, invite.record.invitationId);
    expect(validateInviteSecret(used, invite.secret)).toMatchObject({
      ok: false,
      code: "pairmesh.invite_used"
    });
  });

  it("rejects a revoked invite", () => {
    const invite = createInvite();
    const revoked = revokeOpenInvites({ ...createSessionSecurity(), invites: [invite.record] });

    expect(validateInviteSecret(revoked, invite.secret)).toMatchObject({
      ok: false,
      code: "pairmesh.invite_invalid"
    });
  });
});

describe("inbound bearer credentials", () => {
  it("resolves the participant behind a valid token and rejects unknown tokens", () => {
    const participantId = peerId();
    const issued = issueInboundCredential(participantId);
    const security = { ...createSessionSecurity(), acceptedInbound: [issued.credential] };

    expect(resolveInboundCredential(security, issued.token)?.participantId).toBe(participantId);
    expect(resolveInboundCredential(security, generateBearerToken())).toBeUndefined();
    expect(issued.credential.tokenHash).toBe(hashSecret(issued.token));
  });

  it("stops resolving a revoked participant credential", () => {
    const revokedPeer = peerId();
    const keptPeer = peerId();
    const issued = issueInboundCredential(revokedPeer);
    const other = issueInboundCredential(keptPeer);
    const security = {
      ...createSessionSecurity(),
      acceptedInbound: [issued.credential, other.credential]
    };

    const afterRevoke = revokeInboundCredentials(security, revokedPeer);
    expect(resolveInboundCredential(afterRevoke, issued.token)).toBeUndefined();
    expect(resolveInboundCredential(afterRevoke, other.token)?.participantId).toBe(keptPeer);

    const afterCloseSession = revokeAllInboundCredentials(afterRevoke);
    expect(resolveInboundCredential(afterCloseSession, other.token)).toBeUndefined();
  });

  it("registers a credential for a token generated elsewhere in the handshake", () => {
    const participantId = peerId();
    const token = generateBearerToken();
    const credential = registerInboundCredential(participantId, token);
    const security = { ...createSessionSecurity(), acceptedInbound: [credential] };

    expect(resolveInboundCredential(security, token)?.participantId).toBe(participantId);
  });
});

describe("secret handling", () => {
  it("redacts secrets and derives non-reversible fingerprints", () => {
    const token = generateBearerToken();
    const fingerprint = credentialFingerprint(hashSecret(token));

    expect(redactSecret(token)).toBe(PAIRMESH_REDACTED);
    expect(redactSecret(token)).not.toContain(token);
    expect(redactSecret(undefined)).toBe("");
    expect(fingerprint).toHaveLength(8);
    expect(token).not.toContain(fingerprint);
  });

  it("parses and formats bearer headers", () => {
    const token = generateBearerToken();

    expect(parseBearerHeader(formatBearerHeader(token))).toBe(token);
    expect(parseBearerHeader(`bearer ${token}`)).toBe(token);
    expect(parseBearerHeader(undefined)).toBeUndefined();
    expect(parseBearerHeader("Basic abc")).toBeUndefined();
    expect(parseBearerHeader("Bearer")).toBeUndefined();
  });

  it("attaches the bearer header to outbound requests", async () => {
    const token = generateBearerToken();
    let seenHeader: string | null = null;

    const fetchImpl = createBearerFetch(token, async (input, init) => {
      seenHeader = new Request(input as RequestInfo, init).headers.get("authorization");
      return new Response("{}", { status: 200 });
    });

    await fetchImpl("http://127.0.0.1:4101/a2a", { method: "POST" });
    expect(seenHeader).toBe(`Bearer ${token}`);
  });
});
