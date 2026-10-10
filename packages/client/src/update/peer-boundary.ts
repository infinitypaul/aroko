import { FORBIDDEN_PEER_UPDATE_FRAGMENTS } from "./constants.js";

/** Structural denylist — peer/MCP/A2A surfaces must never expose these. */
export function isForbiddenPeerUpdateCapability(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return FORBIDDEN_PEER_UPDATE_FRAGMENTS.some(
    (fragment) => normalized === fragment || normalized.includes(fragment)
  );
}

export function assertNoPeerUpdateCapabilities(ids: Iterable<string>): void {
  for (const id of ids) {
    if (isForbiddenPeerUpdateCapability(id)) {
      throw new Error(`Forbidden peer update capability exposed: ${id}`);
    }
  }
}
