import {
  PairMeshRuntimeHealthSchema,
  PeerHealthResultSchema,
  createPairMeshError,
  type PairMeshRuntimeHealth,
  type PeerHealthResult
} from "@pairmesh/protocol";
import { normalizeAgentBaseUrl } from "../identity.js";

const peerHealthCache = new Map<string, { value: PeerHealthResult; expiresAt: number }>();
const DEFAULT_CACHE_TTL_MS = 3_000;

export interface FetchPeerHealthOptions {
  cacheTtlMs?: number;
  skipCache?: boolean;
  timeoutMs?: number;
  /** Session bearer for this peer. Without it the peer returns minimal health. */
  bearerToken?: string;
}

export async function fetchPeerHealth(
  peerName: string,
  a2aAgentUrl: string,
  options: FetchPeerHealthOptions = {}
): Promise<PeerHealthResult> {
  const authScope = options.bearerToken ? "authenticated" : "anonymous";
  const cacheKey = `${peerName}:${normalizeAgentBaseUrl(a2aAgentUrl)}:${authScope}`;
  if (!options.skipCache) {
    const cached = peerHealthCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const baseUrl = normalizeAgentBaseUrl(a2aAgentUrl);
  const healthUrl = `${baseUrl}/health`;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  try {
    const response = await fetchWithTimeout(healthUrl, timeoutMs, options.bearerToken);
    if (!response.ok) {
      return cachePeerHealth(cacheKey, ttlMs, {
        peer: peerName,
        reachable: false,
        reason: `Peer PairMesh agent returned HTTP ${response.status}.`
      });
    }

    const payload = (await response.json()) as unknown;
    const parsed = PairMeshRuntimeHealthSchema.safeParse(payload);
    if (!parsed.success) {
      return cachePeerHealth(cacheKey, ttlMs, {
        peer: peerName,
        reachable: false,
        reason: "Peer health response was malformed."
      });
    }

    return cachePeerHealth(cacheKey, ttlMs, {
      peer: peerName,
      reachable: true,
      pairmesh: { status: parsed.data.status },
      ...(parsed.data.codingAgent
        ? {
            codingAgent: {
              provider: parsed.data.codingAgent.provider,
              status: parsed.data.codingAgent.status
            }
          }
        : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cachePeerHealth(cacheKey, ttlMs, {
      peer: peerName,
      reachable: false,
      reason: message.includes("timed out")
        ? "Peer PairMesh agent did not respond in time."
        : "Peer PairMesh agent is unreachable."
    });
  }
}

export async function fetchLocalHealth(
  a2aAgentUrl: string,
  timeoutMs = 3_000
): Promise<PairMeshRuntimeHealth | undefined> {
  const healthUrl = `${normalizeAgentBaseUrl(a2aAgentUrl)}/health`;
  try {
    const response = await fetchWithTimeout(healthUrl, timeoutMs);
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as unknown;
    const parsed = PairMeshRuntimeHealthSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function assertPeerReadyForInspection(peerName: string, health: PeerHealthResult): void {
  if (!health.reachable) {
    throw createPairMeshError({
      code: "pairmesh.peer_unreachable",
      message: `${peerName}'s PairMesh agent is currently unreachable. Ensure the peer agent is running and try again.`,
      details: { peer: peerName }
    });
  }

  // A peer that withheld coding-agent detail is treated as reachable-unknown:
  // the authenticated inspect call itself reports unavailability if it applies.
  if (health.codingAgent?.status === "unavailable") {
    throw createPairMeshError({
      code: "pairmesh.coding_agent_unavailable",
      message: `${peerName}'s coding agent is unavailable. The PairMesh agent is reachable but cannot run inspections right now.`,
      details: { peer: peerName, codingAgentStatus: health.codingAgent.status }
    });
  }
}

function cachePeerHealth(
  cacheKey: string,
  ttlMs: number,
  value: PeerHealthResult
): PeerHealthResult {
  const result = PeerHealthResultSchema.parse(value);
  peerHealthCache.set(cacheKey, { value: result, expiresAt: Date.now() + ttlMs });
  return result;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  bearerToken?: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      ...(bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {})
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function clearPeerHealthCache(): void {
  peerHealthCache.clear();
}

/** Drop cached health for a peer/URL so rebind does not look falsely ready/offline. */
export function invalidatePeerHealthCache(input: {
  peerName?: string;
  a2aAgentUrl?: string;
}): void {
  const peerName = input.peerName?.trim();
  const url = input.a2aAgentUrl ? normalizeAgentBaseUrl(input.a2aAgentUrl) : undefined;
  if (!peerName && !url) {
    peerHealthCache.clear();
    return;
  }
  for (const key of [...peerHealthCache.keys()]) {
    // key = `${peerName}:${normalizeAgentBaseUrl(a2aAgentUrl)}:${authScope}`
    const authSep = key.lastIndexOf(":");
    if (authSep <= 0) continue;
    const withoutAuth = key.slice(0, authSep);
    const nameSep = withoutAuth.indexOf(":");
    if (nameSep <= 0) continue;
    const name = withoutAuth.slice(0, nameSep);
    const cachedUrl = withoutAuth.slice(nameSep + 1);
    if (peerName && name !== peerName) continue;
    if (url && cachedUrl !== url) continue;
    peerHealthCache.delete(key);
  }
}
