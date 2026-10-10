import type { RelayBridge } from "./relay-bridge.js";

let runtimeBridge: RelayBridge | null = null;

export function setRuntimeRelayBridge(bridge: RelayBridge | null): void {
  runtimeBridge = bridge;
}

export function getRuntimeRelayBridge(): RelayBridge | null {
  return runtimeBridge;
}
