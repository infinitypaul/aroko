import { randomBytes, timingSafeEqual } from "node:crypto";

/** Default TTL for one-time Control exchange codes (R22-4). */
export const CONTROL_EXCHANGE_TTL_MS = 120_000;

interface ExchangeEntry {
  controlToken: string;
  expiresAtMs: number;
}

/**
 * In-memory single-use exchange codes that redeem to the long-lived Control Bearer.
 * Codes are never logged; long-lived token never goes in the launch URL.
 */
export class ControlExchangeStore {
  private readonly entries = new Map<string, ExchangeEntry>();

  public mint(
    controlToken: string,
    ttlMs = CONTROL_EXCHANGE_TTL_MS
  ): {
    code: string;
    expiresAt: string;
  } {
    this.purgeExpired();
    const code = `cxc_${randomBytes(24).toString("base64url")}`;
    const expiresAtMs = Date.now() + ttlMs;
    this.entries.set(code, { controlToken, expiresAtMs });
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Redeem once. Returns the control token or null (expired / used / unknown).
   * Comparison walks entries with timing-safe equality on code strings of equal length.
   */
  public redeem(presented: string): string | null {
    this.purgeExpired();
    const trimmed = presented.trim();
    if (!trimmed.startsWith("cxc_") || trimmed.length < 20 || trimmed.length > 200) {
      return null;
    }
    const presentedBuf = Buffer.from(trimmed);
    let matched: ExchangeEntry | undefined;
    let matchedKey: string | undefined;
    for (const [code, entry] of this.entries) {
      const codeBuf = Buffer.from(code);
      if (codeBuf.length !== presentedBuf.length) {
        continue;
      }
      if (timingSafeEqual(codeBuf, presentedBuf)) {
        matched = entry;
        matchedKey = code;
      }
    }
    if (!matched || !matchedKey) {
      return null;
    }
    if (matched.expiresAtMs <= Date.now()) {
      this.entries.delete(matchedKey);
      return null;
    }
    this.entries.delete(matchedKey);
    return matched.controlToken;
  }

  public get size(): number {
    return this.entries.size;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [code, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(code);
      }
    }
  }
}
