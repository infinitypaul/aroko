import type { RelaySessionId } from "./frames.js";

export interface RemoteRendezvousRecord {
  sessionCode: string;
  relaySessionId: RelaySessionId;
  relayWsUrl: string;
  creatorTransportPublicKey: string;
  expiresAt: string;
}

export async function createRemoteRelaySession(input: {
  relayHttpBaseUrl: string;
  relayAccessToken: string;
  relaySessionId: RelaySessionId;
}): Promise<{ relaySessionId: RelaySessionId }> {
  const response = await fetch(
    new URL("/v1/sessions", ensureTrailingSlash(input.relayHttpBaseUrl)),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "1"
      },
      body: JSON.stringify({
        relayAccessToken: input.relayAccessToken,
        relaySessionId: input.relaySessionId
      })
    }
  );
  // 409 with same credentials is treated as success by the hosted server; any
  // other conflict still surfaces. Accept 201 and idempotent 200/409-ok paths.
  if (response.status === 409) {
    // Same-id recreate after wipe is now idempotent 201; stale conflicts remain 409.
    // Retry attach anyway — creator ensure is best-effort.
    return { relaySessionId: input.relaySessionId };
  }
  if (!response.ok) {
    throw new Error(`Relay session create failed (${response.status})`);
  }
  const json = (await response.json()) as { relaySessionId: string };
  return { relaySessionId: json.relaySessionId as RelaySessionId };
}

export async function registerRemoteRendezvous(input: {
  relayHttpBaseUrl: string;
  sessionCode: string;
  relaySessionId: RelaySessionId;
  relayWsUrl: string;
  creatorTransportPublicKey: string;
}): Promise<RemoteRendezvousRecord> {
  const response = await fetch(
    new URL("/v1/rendezvous", ensureTrailingSlash(input.relayHttpBaseUrl)),
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "1"
      },
      body: JSON.stringify({
        sessionCode: input.sessionCode,
        relaySessionId: input.relaySessionId,
        relayWsUrl: input.relayWsUrl,
        creatorTransportPublicKey: input.creatorTransportPublicKey
      })
    }
  );
  if (!response.ok) {
    throw new Error(`Rendezvous register failed (${response.status})`);
  }
  return (await response.json()) as RemoteRendezvousRecord;
}

export async function lookupRemoteRendezvous(input: {
  relayHttpBaseUrl: string;
  sessionCode: string;
}): Promise<RemoteRendezvousRecord | null> {
  const response = await fetch(
    new URL(
      `/v1/rendezvous/${encodeURIComponent(input.sessionCode.trim())}`,
      ensureTrailingSlash(input.relayHttpBaseUrl)
    ),
    {
      headers: { "ngrok-skip-browser-warning": "1" }
    }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Rendezvous lookup failed (${response.status})`);
  }
  return (await response.json()) as RemoteRendezvousRecord;
}

export async function registerRemoteRelayAccessToken(input: {
  relayHttpBaseUrl: string;
  relaySessionId: RelaySessionId;
  authorizingToken: string;
  newToken: string;
}): Promise<void> {
  const response = await fetch(
    new URL("/v1/sessions/tokens", ensureTrailingSlash(input.relayHttpBaseUrl)),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "1"
      },
      body: JSON.stringify({
        relaySessionId: input.relaySessionId,
        authorizingToken: input.authorizingToken,
        newToken: input.newToken
      })
    }
  );
  if (!response.ok) {
    throw new Error(`Relay access token register failed (${response.status})`);
  }
}

/** Convert wss://host/relay → https://host for HTTP rendezvous API. */
export function relayWsUrlToHttpBase(relayWsUrl: string): string {
  const url = new URL(relayWsUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}
