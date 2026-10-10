import type { PairMeshLocalConfig } from "../local-config/schema.js";

export const PAIRMESH_HOSTED_RELAY_WS_URL = "wss://relay.aroko.dev/";

export function isRelayConnectivityMode(
  config: Pick<PairMeshLocalConfig, "connectivity">
): boolean {
  return config.connectivity?.mode === "relay";
}

/**
 * Resolve the WebSocket URL for relay mode.
 * Explicit `connectivity.relayUrl` wins; otherwise use the hosted default.
 */
export function resolveRelayWsUrl(config: Pick<PairMeshLocalConfig, "connectivity">): string {
  if (!isRelayConnectivityMode(config)) {
    throw new Error("resolveRelayWsUrl requires connectivity.mode=relay");
  }
  const explicit = config.connectivity?.relayUrl?.trim();
  if (explicit) {
    return explicit;
  }
  return PAIRMESH_HOSTED_RELAY_WS_URL;
}

/** True when config stores a non-default relay URL override. */
export function hasRelayUrlOverride(config: Pick<PairMeshLocalConfig, "connectivity">): boolean {
  return Boolean(config.connectivity?.relayUrl?.trim());
}

export function describeRelayWsUrl(config: Pick<PairMeshLocalConfig, "connectivity">): string {
  if (!isRelayConnectivityMode(config)) {
    return "n/a";
  }
  const url = resolveRelayWsUrl(config);
  if (hasRelayUrlOverride(config)) {
    return `${url} (override)`;
  }
  return `${url} (hosted default)`;
}
