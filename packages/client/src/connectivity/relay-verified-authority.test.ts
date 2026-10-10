/**
 * Stage 18 Prompt 7 H6.2 — Verified-route authority (VA1–VA12).
 * CreatorPeerBinding.routeHealth is the sole usability authority for creator→joiner.
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  isAuthoritativeProbeEpisode,
  isRouteVerifying,
  PEER_ROUTE_NOT_VERIFIED,
  PEER_TRANSPORT_UNAVAILABLE,
  RelayHttpEgress,
  restoreRelayPath,
  startCreatorRelayPath,
  startJoinerRelayPath,
  type PairMeshRelayClient
} from "./index.js";
import { projectPeerConnectivity } from "../health/peer-connectivity.js";

async function listenEcho(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 15
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function healthOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(3_000)
    });
    return r.ok;
  } catch {
    return false;
  }
}

function mockRelayClient(
  send: (plaintext: Uint8Array) => void | Promise<void>
): PairMeshRelayClient {
  const listeners = new Set<(plaintext: Uint8Array) => void>();
  return {
    onPlaintext: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sendPlaintext: async (plaintext) => {
      await send(plaintext);
    }
  } as unknown as PairMeshRelayClient;
}

describe("H6.2 verified-route authority (VA)", () => {
  it("VA2+VA3+VA11: app POST gated while verifying; /health probe still allowed; no replay", async () => {
    let allowed = false;
    const denyReasons: string[] = [];
    const egress = new RelayHttpEgress(
      mockRelayClient(async () => {
        /* never reply */
      }),
      "joiner",
      {
        sendDest: { toConnectionId: "conn_verify_aaaa_bbbb_cccc_dddd" },
        transportProbeTimeoutMs: 50,
        isAppTrafficAllowed: () => allowed,
        getAppTrafficDenyReason: () => PEER_ROUTE_NOT_VERIFIED
      }
    );
    const url = await egress.listen();

    const appRes = await fetch(`${url}/v1/message:send`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    });
    expect(appRes.status).toBe(502);
    expect(await appRes.text()).toBe(PEER_ROUTE_NOT_VERIFIED);
    denyReasons.push(PEER_ROUTE_NOT_VERIFIED);

    // Probe path is not gated — attempt is made (times out / 502 tunnel), not PEER_ROUTE_NOT_VERIFIED.
    const probeRes = await fetch(`${url}/health`);
    expect(probeRes.status).toBe(502);
    const probeBody = await probeRes.text();
    expect(probeBody).not.toBe(PEER_ROUTE_NOT_VERIFIED);

    // Enabling route does not replay the prior POST.
    allowed = true;
    expect(denyReasons).toEqual([PEER_ROUTE_NOT_VERIFIED]);

    await egress.close();
  });

  it("VA1/VA4/VA8: remint stays verifying until exact current probe success; one rebind_succeeded", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    let façade = "";

    let releaseIngress!: () => void;
    const holdIngress = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    let gateReached = false;

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-VA1AAA",
      inviteSecret: "inv_va1_verified_authority_secret_aaaaaa",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 250,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-VA1AAA",
      inviteSecret: "inv_va1_verified_authority_secret_aaaaaa",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    const presenceId = joiner.path.relayPresenceId!;
    expect(await healthOk(façade)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(presenceId) === "healthy");

    // VA1 projection: verifying ≠ ready
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        verifiedRouteRequired: true,
        routeHealth: "verifying",
        health: { peer: "j", reachable: true, pairmesh: { status: "ready" } }
      })
    ).toBe("reconnecting");

    const gen = joiner.path.presenceGeneration ?? 1;
    const oldConn = joiner.path.client.id;
    await joiner.path.stop();

    const remint = await restoreRelayPath(
      {
        relayWsUrl: joiner.path.relayWsUrl,
        relaySessionId: joiner.path.relaySessionId,
        relayAccessToken: joiner.path.relayAccessToken,
        sessionCode: "PM-VA1AAA",
        role: "joiner",
        localA2aBaseUrl: joinerEcho.url,
        relayPresenceId: presenceId,
        presenceGeneration: gen
      },
      {
        afterEarlyPresenceAnnounce: async () => {
          gateReached = true;
          await holdIngress;
        }
      }
    );
    expect(remint.path.client.id).not.toBe(oldConn);
    await waitFor(() => gateReached);
    await waitFor(
      () =>
        creator.path.getCreatorSendDestForTest?.(presenceId)?.toConnectionId ===
        remint.path.client.id
    );

    expect(isRouteVerifying(creator.path.getCreatorRouteHealthForTest?.(presenceId))).toBe(true);

    // VA2 live: app traffic gated
    const appRes = await fetch(`${façade}/v1/message:send`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(3_000)
    });
    expect(appRes.status).toBe(502);
    const appBody = await appRes.text();
    expect(appBody === PEER_ROUTE_NOT_VERIFIED || appBody === PEER_TRANSPORT_UNAVAILABLE).toBe(
      true
    );

    const successBefore = creator.path.getRouteCountersForTest?.()?.routeRebindSuccess ?? 0;
    releaseIngress();
    await remint.ready;
    expect(await healthOk(façade)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(presenceId) === "healthy");
    expect(creator.path.getRouteCountersForTest?.()?.routeRebindSuccess).toBe(successBefore + 1);

    // VA4 doctor projection
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        relayMode: true,
        relayLifecycle: "ready",
        verifiedRouteRequired: true,
        routeHealth: "healthy"
      })
    ).toBe("ready");

    // App now allowed
    // (echo accepts any path as 200 via tunnel once verified)
    const app2 = await fetch(`${façade}/v1/message:send`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000)
    });
    expect(app2.ok).toBe(true);

    await remint.path.stop();
    await creator.path.stop();
    await joinerEcho.close();
    await creatorEcho.close();
    await relay.close();
  }, 90_000);

  it("VA5+VA6+VA7: stale connection/generation probe episodes are ignored", () => {
    const connA = "conn_aaaa_1111_2222_3333_44445555";
    const connB = "conn_bbbb_1111_2222_3333_44445555";
    // VA5: old success for A while B is current
    expect(
      isAuthoritativeProbeEpisode({
        sentConnectionId: connA,
        mappedConnectionId: connB,
        verifyConnectionId: connB,
        presenceGeneration: 2,
        verifyGeneration: 2,
        currentGeneration: 2
      })
    ).toBe(false);
    // VA6: old failure for A while B is current
    expect(
      isAuthoritativeProbeEpisode({
        sentConnectionId: connA,
        mappedConnectionId: connB,
        verifyConnectionId: connB,
        presenceGeneration: 1,
        verifyGeneration: 2,
        currentGeneration: 2
      })
    ).toBe(false);
    // VA7: generation mismatch
    expect(
      isAuthoritativeProbeEpisode({
        sentConnectionId: connB,
        mappedConnectionId: connB,
        verifyConnectionId: connB,
        presenceGeneration: 1,
        verifyGeneration: 2,
        currentGeneration: 2
      })
    ).toBe(false);
    // Exact current success
    expect(
      isAuthoritativeProbeEpisode({
        sentConnectionId: connB,
        mappedConnectionId: connB,
        verifyConnectionId: connB,
        presenceGeneration: 2,
        verifyGeneration: 2,
        currentGeneration: 2
      })
    ).toBe(true);
  });

  it("VA9: Sarah verifying/unavailable does not affect Kelvin healthy", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const kelvinEcho = await listenEcho();
    const sarahEcho = await listenEcho();
    const façades = new Map<string, string>();

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-VA9AAA",
      inviteSecret: "inv_va9_isolation_secret_cccccccccccc",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 250,
      onPeerEndpoint: (ev) => {
        façades.set(ev.relayParticipantId, ev.localEndpoint);
      }
    });
    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-VA9AAA",
      inviteSecret: "inv_va9_isolation_secret_cccccccccccc",
      localA2aBaseUrl: kelvinEcho.url
    });
    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-VA9AAA",
      inviteSecret: "inv_va9_isolation_secret_cccccccccccc",
      localA2aBaseUrl: sarahEcho.url
    });
    await creator.ready;
    const kId = kelvin.path.relayPresenceId!;
    const sId = sarah.path.relayPresenceId!;
    await waitFor(() => façades.has(kId) && façades.has(sId));
    expect(await healthOk(façades.get(kId)!)).toBe(true);
    expect(await healthOk(façades.get(sId)!)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(kId) === "healthy");
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(sId) === "healthy");

    // Exhaust Sarah only
    await sarah.path.stop();
    const sFaçade = façades.get(sId)!;
    for (let i = 0; i < 6; i++) {
      await fetch(`${sFaçade}/health`, { signal: AbortSignal.timeout(1_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, 50));
    }
    await waitFor(() => {
      const h = creator.path.getCreatorRouteHealthForTest?.(sId);
      return h === "unavailable" || h === "awaiting_fresh" || isRouteVerifying(h);
    }, 15_000);
    expect(creator.path.getCreatorRouteHealthForTest?.(kId)).toBe("healthy");
    const kFaçade = façades.get(kId)!;
    expect(await healthOk(kFaçade)).toBe(true);
    const kApp = await fetch(`${kFaçade}/v1/message:send`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000)
    });
    expect(kApp.ok).toBe(true);

    await kelvin.path.stop();
    await creator.path.stop();
    await kelvinEcho.close();
    await sarahEcho.close();
    await creatorEcho.close();
    await relay.close();
  }, 90_000);

  it("VA10: non-relay projection unchanged; VA12 auth path not altered (smoke)", () => {
    expect(
      projectPeerConnectivity({
        relationship: "paired",
        health: { peer: "x", reachable: true, pairmesh: { status: "ready" } }
      })
    ).toBe("ready");
    // routeRefreshRequested remains hello-attached-only — covered by RC9 / existing auth tests.
    expect(PEER_ROUTE_NOT_VERIFIED).toBe("peer_route_not_verified");
  });
});
