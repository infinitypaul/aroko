import { timingSafeEqual } from "node:crypto";

const RELAY_ACCESS_TOKEN_RE = /^rat_[0-9a-f]{48}$/i;

/**
 * Timing-safe membership check for relay attach tokens.
 *
 * Tokens are high-entropy (`rat_` + 48 hex). Set iteration is small (per-session).
 * Format reject is cheap and non-secret. Equal-length candidates use timingSafeEqual;
 * we do not claim this removes all side channels from Set iteration order.
 */
export function relayAccessTokenSetContains(
  tokens: ReadonlySet<string>,
  presented: string
): boolean {
  if (typeof presented !== "string" || !RELAY_ACCESS_TOKEN_RE.test(presented)) {
    return false;
  }
  const presentedNorm = presented.toLowerCase();
  const presentedBuf = Buffer.from(presentedNorm);
  let found = false;
  for (const candidate of tokens) {
    if (!RELAY_ACCESS_TOKEN_RE.test(candidate)) {
      continue;
    }
    const candidateBuf = Buffer.from(candidate.toLowerCase());
    if (candidateBuf.length !== presentedBuf.length) {
      continue;
    }
    if (timingSafeEqual(candidateBuf, presentedBuf)) {
      found = true;
    }
  }
  return found;
}
