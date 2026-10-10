import { describe, expect, it } from "vitest";
import {
  PAIRMESH_HOSTED_RELAY_WS_URL,
  describeRelayWsUrl,
  hasRelayUrlOverride,
  resolveRelayWsUrl
} from "./hosted-relay-default.js";

describe("hosted relay default (Stage 18 Prompt 7)", () => {
  it("uses built-in Aroko relay when mode=relay and relayUrl omitted", () => {
    expect(
      resolveRelayWsUrl({
        connectivity: { mode: "relay" }
      })
    ).toBe(PAIRMESH_HOSTED_RELAY_WS_URL);
    expect(hasRelayUrlOverride({ connectivity: { mode: "relay" } })).toBe(false);
    expect(describeRelayWsUrl({ connectivity: { mode: "relay" } })).toContain("hosted default");
  });

  it("preserves explicit relayUrl override", () => {
    const override = "wss://relay.example.test/relay";
    expect(
      resolveRelayWsUrl({
        connectivity: { mode: "relay", relayUrl: override }
      })
    ).toBe(override);
    expect(
      hasRelayUrlOverride({
        connectivity: { mode: "relay", relayUrl: override }
      })
    ).toBe(true);
    expect(
      describeRelayWsUrl({
        connectivity: { mode: "relay", relayUrl: override }
      })
    ).toContain("override");
  });

  it("rejects resolve when not in relay mode", () => {
    expect(() =>
      resolveRelayWsUrl({
        connectivity: { mode: "direct-url" }
      })
    ).toThrow(/requires connectivity.mode=relay/);
  });
});
