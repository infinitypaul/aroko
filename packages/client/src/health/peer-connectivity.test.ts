import { describe, expect, it } from "vitest";
import { projectPeerAgentStatus, projectPeerConnectivity } from "./peer-connectivity.js";

describe("projectPeerConnectivity", () => {
  it("returns none for unpaired members", () => {
    expect(
      projectPeerConnectivity({
        relationship: "unpaired"
      })
    ).toBe("none");
  });

  it("returns ready when relay is ready and peer health responds (no verified-route gate)", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        health: {
          peer: "sarah",
          reachable: true,
          pairmesh: { status: "ready" },
          codingAgent: { provider: "cursor", status: "available" }
        }
      })
    ).toBe("ready");
  });

  it("VA1/VA4: verifiedRouteRequired — verifying is not ready even if /health ok", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        verifiedRouteRequired: true,
        routeHealth: "verifying",
        health: {
          peer: "kelvin",
          reachable: true,
          pairmesh: { status: "ready" },
          codingAgent: { provider: "cursor", status: "available" }
        }
      })
    ).toBe("reconnecting");
  });

  it("VA4: verifiedRouteRequired + healthy → ready without depending on health alone", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        verifiedRouteRequired: true,
        routeHealth: "healthy"
      })
    ).toBe("ready");
  });

  it("verifiedRouteRequired + unavailable → offline", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        verifiedRouteRequired: true,
        routeHealth: "unavailable",
        health: { peer: "kelvin", reachable: true, pairmesh: { status: "ready" } }
      })
    ).toBe("offline");
  });

  it("VA10: non-relay reachable stays ready", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: false,
        health: { peer: "local", reachable: true, pairmesh: { status: "ready" } }
      })
    ).toBe("ready");
  });

  it("returns offline when health probe fails despite paired relationship", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        health: { peer: "kelvin", reachable: false, reason: "timeout" }
      })
    ).toBe("offline");
  });

  it("returns reconnecting when relay is mid-recovery", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "reconnecting",
        health: { peer: "kelvin", reachable: true, pairmesh: { status: "ready" } }
      })
    ).toBe("reconnecting");
  });

  it("returns ready for reachable transport when receiver withheld auth detail", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        health: { peer: "kelvin", reachable: true, pairmesh: { status: "ready" } }
      })
    ).toBe("ready");
  });
});

describe("projectPeerAgentStatus", () => {
  it("returns unknown when coding-agent detail is withheld", () => {
    expect(
      projectPeerAgentStatus({
        peer: "kelvin",
        reachable: true,
        pairmesh: { status: "ready" }
      })
    ).toBe("unknown");
  });

  it("returns ready when coding agent is available", () => {
    expect(
      projectPeerAgentStatus({
        peer: "sarah",
        reachable: true,
        pairmesh: { status: "ready" },
        codingAgent: { provider: "cursor", status: "available" }
      })
    ).toBe("ready");
  });
});
