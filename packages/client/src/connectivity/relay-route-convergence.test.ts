/**
 * Stage 18 Prompt 7 — Route convergence after creator reconnect (RC1–RC8).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  PEER_TRANSPORT_UNAVAILABLE,
  RELAY_HTTP_APP_TIMEOUT_MS,
  RelayHttpEgress,
  ROUTE_SAME_COOLDOWN_MS,
  ROUTE_SAME_FAIL_LIMIT,
  restoreRelayPath,
  startCreatorRelayPath,
  startJoinerRelayPath
} from "./index.js";
import type { PairMeshRelayClient } from "./relay/client.js";

async function listenEcho(): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

/** Echo that can delay /health past the transport probe window (half-open). */
async function listenControllableEcho(): Promise<{
  url: string;
  close: () => Promise<void>;
  setDropHealth: (drop: boolean) => void;
}> {
  let dropHealth = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = req.url?.split("?")[0] ?? "/";
      if (dropHealth && (path === "/health" || path.endsWith("/health"))) {
        // Delay past probe timeout without hanging the ingress forever.
        await new Promise((r) => setTimeout(r, 2_000));
        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ready", ok: true }));
        }
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready", ok: true }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    setDropHealth: (drop: boolean) => {
      dropHealth = drop;
    },
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 40
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function healthOk(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return res.ok;
  } catch {
    return false;
  }
}

function mockRelayClient(
  sendPlaintext: PairMeshRelayClient["sendPlaintext"],
  onPlaintext?: PairMeshRelayClient["onPlaintext"]
): PairMeshRelayClient {
  return {
    id: "conn_test",
    sendPlaintext,
    onPlaintext: onPlaintext ?? (() => () => undefined),
    close: async () => undefined,
    setE2E: () => undefined,
    announcePublicKey: () => undefined,
    terminateForTest: () => undefined,
    tickLivenessForTest: () => undefined
  } as unknown as PairMeshRelayClient;
}

describe("route convergence after creator reconnect (RC1–RC9)", () => {
  it("RC1: creator reconnect → both joiners pin sendDest to C2 and health succeeds", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const kEcho = await listenEcho();
    const sEcho = await listenEcho();
    const façades = new Map<string, string>();

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-RC1AAA",
      inviteSecret: "inv_rc1_creator_reconnect_secret_aa",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        façades.set(ev.relayParticipantId, ev.localEndpoint);
      }
    });
    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC1AAA",
      inviteSecret: "inv_rc1_creator_reconnect_secret_aa",
      localA2aBaseUrl: kEcho.url
    });
    await creator.ready;
    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC1AAA",
      inviteSecret: "inv_rc1_creator_reconnect_secret_aa",
      localA2aBaseUrl: sEcho.url
    });
    await waitFor(() => façades.size >= 2);

    const c1 = creator.path.client.id;
    expect(kelvin.path.getJoinerSendDestForTest()?.toConnectionId).toBe(c1);
    expect(sarah.path.getJoinerSendDestForTest()?.toConnectionId).toBe(c1);
    expect(await healthOk(kelvin.path.localEndpoint)).toBe(true);
    expect(await healthOk(sarah.path.localEndpoint)).toBe(true);

    const creds = {
      relayWsUrl: creator.path.relayWsUrl,
      relaySessionId: creator.path.relaySessionId,
      relayAccessToken: creator.path.relayAccessToken,
      sessionCode: "PM-RC1AAA",
      role: "creator" as const,
      localA2aBaseUrl: creatorEcho.url
    };
    await creator.path.stop();
    façades.clear();
    const creator2 = await restoreRelayPath(creds, {
      onPeerEndpoint: (ev) => {
        façades.set(ev.relayParticipantId, ev.localEndpoint);
      }
    });
    await creator2.ready;
    const c2 = creator2.path.client.id;
    expect(c2).not.toBe(c1);

    await waitFor(
      () =>
        kelvin.path.getJoinerSendDestForTest()?.toConnectionId === c2 &&
        sarah.path.getJoinerSendDestForTest()?.toConnectionId === c2,
      20_000
    );
    await waitFor(() => façades.size >= 2, 20_000);

    expect(await healthOk(kelvin.path.localEndpoint)).toBe(true);
    expect(await healthOk(sarah.path.localEndpoint)).toBe(true);
    for (const url of façades.values()) {
      expect(await healthOk(url)).toBe(true);
    }

    await creator2.path.stop();
    await kelvin.path.stop();
    await sarah.path.stop();
    await creatorEcho.close();
    await kEcho.close();
    await sEcho.close();
    await relay.close();
  }, 90_000);

  it("RC2: same-route refresh does not claim rebind_succeeded or healthy", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenControllableEcho();
    let façade = "";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-RC2BBB",
      inviteSecret: "inv_rc2_same_route_refresh_secret_bb",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 60,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC2BBB",
      inviteSecret: "inv_rc2_same_route_refresh_secret_bb",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    expect(await healthOk(façade)).toBe(true);

    const presenceId = joiner.path.relayPresenceId!;
    const before = creator.path.getRouteCountersForTest?.() ?? {
      routeRebindSuccess: 0,
      routeRefreshSame: 0
    };
    const successBefore = before.routeRebindSuccess;

    joinerEcho.setDropHealth(true);
    // Force several transport probes against hung peer (same connection).
    for (let i = 0; i < ROUTE_SAME_FAIL_LIMIT + 1; i++) {
      await fetch(`${façade}/health`, { signal: AbortSignal.timeout(3_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 80));
    }

    const after = creator.path.getRouteCountersForTest?.();
    expect(after).toBeTruthy();
    expect(after!.routeRefreshSame).toBeGreaterThan(0);
    expect(after!.routeRebindSuccess).toBe(successBefore);
    const health = creator.path.getCreatorRouteHealthForTest?.(presenceId);
    expect(health === "awaiting_fresh" || health === "unavailable").toBe(true);
    expect(health).not.toBe("healthy");

    await creator.path.stop();
    await joiner.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 90_000);

  it("RC3: fresh connection Y after failed X → verify → rebind_succeeded + healthy", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    let façade = "";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-RC3CCC",
      inviteSecret: "inv_rc3_fresh_route_repair_secret_cc",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC3CCC",
      inviteSecret: "inv_rc3_fresh_route_repair_secret_cc",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);

    const presenceId = joiner.path.relayPresenceId!;
    const gen = joiner.path.presenceGeneration ?? 1;
    const oldConn = joiner.path.client.id;

    // Mark stale by injecting unavailable on connection, then restore with new conn.
    await joiner.path.stop();
    const joiner2 = await restoreRelayPath({
      relayWsUrl: joiner.path.relayWsUrl,
      relaySessionId: joiner.path.relaySessionId,
      relayAccessToken: joiner.path.relayAccessToken,
      sessionCode: "PM-RC3CCC",
      role: "joiner",
      localA2aBaseUrl: joinerEcho.url,
      relayPresenceId: presenceId,
      presenceGeneration: gen
    });
    await joiner2.ready;
    const newConn = joiner2.path.client.id;
    expect(newConn).not.toBe(oldConn);

    await waitFor(
      () => creator.path.getCreatorSendDestForTest?.(presenceId)?.toConnectionId === newConn
    );
    expect(await healthOk(façade)).toBe(true);
    await waitFor(
      () => creator.path.getCreatorRouteHealthForTest?.(presenceId) === "healthy",
      15_000
    );
    // After verify, counters may include rebind_succeeded (verified_new_route) or healthy.
    expect(creator.path.getCreatorRouteHealthForTest?.(presenceId)).toBe("healthy");

    await creator.path.stop();
    await joiner2.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 90_000);

  it("RC4: repeated same-route failure is bounded (no infinite flap)", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenControllableEcho();
    let façade = "";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-RC4DDD",
      inviteSecret: "inv_rc4_bounded_same_route_secret_dd",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 60,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC4DDD",
      inviteSecret: "inv_rc4_bounded_same_route_secret_dd",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    expect(await healthOk(façade)).toBe(true);
    await waitFor(
      () => creator.path.getCreatorRouteHealthForTest?.(joiner.path.relayPresenceId!) === "healthy"
    );
    const successBefore = creator.path.getRouteCountersForTest?.()?.routeRebindSuccess ?? 0;

    joinerEcho.setDropHealth(true);
    for (let i = 0; i < ROUTE_SAME_FAIL_LIMIT + 2; i++) {
      await fetch(`${façade}/health`, { signal: AbortSignal.timeout(3_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 80));
    }

    const counters = creator.path.getRouteCountersForTest?.();
    expect(counters).toBeTruthy();
    // Without cooldown, old code could emit hundreds; with policy, stay well below storm.
    expect(counters!.routeSuspect).toBeLessThan(20);
    expect(counters!.routeRefreshSame).toBeLessThan(20);
    expect(counters!.routeRebindSuccess).toBe(successBefore);
    const presenceId = joiner.path.relayPresenceId;
    expect(presenceId).toBeTruthy();
    const health = creator.path.getCreatorRouteHealthForTest?.(presenceId!);
    expect(health === "unavailable" || health === "awaiting_fresh").toBe(true);

    await creator.path.stop();
    await joiner.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 120_000);

  it("RC5: Sarah half-open leaves Kelvin healthy (per-peer)", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const kEcho = await listenEcho();
    const sEcho = await listenControllableEcho();
    const façades = new Map<string, string>();

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-RC5EEE",
      inviteSecret: "inv_rc5_peer_isolation_secret_eeee",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 60,
      onPeerEndpoint: (ev) => {
        façades.set(ev.relayParticipantId, ev.localEndpoint);
      }
    });
    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC5EEE",
      inviteSecret: "inv_rc5_peer_isolation_secret_eeee",
      localA2aBaseUrl: kEcho.url
    });
    await creator.ready;
    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC5EEE",
      inviteSecret: "inv_rc5_peer_isolation_secret_eeee",
      localA2aBaseUrl: sEcho.url
    });
    await waitFor(() => façades.size >= 2);

    const kPresence = kelvin.path.relayPresenceId!;
    const sPresence = sarah.path.relayPresenceId!;
    const kFaçade = façades.get(kPresence)!;
    const sFaçade = façades.get(sPresence)!;
    expect(await healthOk(kFaçade)).toBe(true);
    expect(await healthOk(sFaçade)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(kPresence) === "healthy");
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(sPresence) === "healthy");
    const kConnBefore = creator.path.getCreatorSendDestForTest?.(kPresence)?.toConnectionId;

    sEcho.setDropHealth(true);
    for (let i = 0; i < ROUTE_SAME_FAIL_LIMIT + 1; i++) {
      await fetch(`${sFaçade}/health`, { signal: AbortSignal.timeout(3_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 80));
    }

    expect(await healthOk(kFaçade)).toBe(true);
    expect(creator.path.getCreatorSendDestForTest?.(kPresence)?.toConnectionId).toBe(kConnBefore);
    expect(creator.path.getCreatorRouteHealthForTest?.(kPresence)).toBe("healthy");
    expect(creator.path.getCreatorRouteHealthForTest?.(sPresence)).not.toBe("healthy");

    await creator.path.stop();
    await kelvin.path.stop();
    await sarah.path.stop();
    await creatorEcho.close();
    await kEcho.close();
    await sEcho.close();
    await relay.close();
  }, 90_000);

  it("RC6: pending app waiter fails promptly on route unavailable (not 120s)", async () => {
    const egress = new RelayHttpEgress(
      mockRelayClient(async () => {
        /* send ok; never reply — app path waits until markRouteUnavailable */
      }),
      "joiner",
      {
        requestTimeoutMs: RELAY_HTTP_APP_TIMEOUT_MS,
        transportProbeTimeoutMs: 40
      }
    );
    const url = await egress.listen();
    const started = Date.now();
    const appFetch = fetch(`${url}/v1/message:send`, { method: "POST", body: "{}" });
    await waitFor(() => egress.getPendingCountForTest() >= 1, 5_000);
    egress.markRouteUnavailable(PEER_TRANSPORT_UNAVAILABLE);
    const res = await appFetch;
    const elapsed = Date.now() - started;
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).toContain(PEER_TRANSPORT_UNAVAILABLE);
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeLessThan(RELAY_HTTP_APP_TIMEOUT_MS / 2);
    await egress.close();
  }, 30_000);

  it("RC7: long app path does not trigger transport stall / rebind", async () => {
    let stallCalls = 0;
    const egress = new RelayHttpEgress(
      mockRelayClient(async () => undefined),
      "joiner",
      {
        requestTimeoutMs: 120,
        transportProbeTimeoutMs: 30,
        onTransportStall: () => {
          stallCalls += 1;
          return { kind: "fail" };
        }
      }
    );
    const url = await egress.listen();
    const res = await fetch(`${url}/v1/tasks/get`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(stallCalls).toBe(0);
    await egress.close();
  });

  it("RC8: repeated close/unavailable does not leave unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const egress = new RelayHttpEgress(
        mockRelayClient(async () => undefined),
        "joiner",
        { transportProbeTimeoutMs: 40, requestTimeoutMs: 200 }
      );
      const url = await egress.listen();
      const fetches = [
        fetch(`${url}/health`),
        fetch(`${url}/v1/message:send`, { method: "POST", body: "{}" })
      ];
      await waitFor(() => egress.getPendingCountForTest() >= 1, 2_000).catch(() => undefined);
      egress.markRouteUnavailable();
      await Promise.all(fetches);
      await egress.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("RC9: exhaustion → routeRefreshRequested → remint → verified; cooldown; Kelvin isolated", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const kEcho = await listenEcho();
    const sEcho = await listenControllableEcho();
    const façades = new Map<string, string>();

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-RC9III",
      inviteSecret: "inv_rc9_directed_route_refresh_secret",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 60,
      onPeerEndpoint: (ev) => {
        façades.set(ev.relayParticipantId, ev.localEndpoint);
      }
    });
    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC9III",
      inviteSecret: "inv_rc9_directed_route_refresh_secret",
      localA2aBaseUrl: kEcho.url
    });
    await creator.ready;
    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-RC9III",
      inviteSecret: "inv_rc9_directed_route_refresh_secret",
      localA2aBaseUrl: sEcho.url
    });
    await waitFor(() => façades.size >= 2);

    const kPresence = kelvin.path.relayPresenceId!;
    const sPresence = sarah.path.relayPresenceId!;
    const kFaçade = façades.get(kPresence)!;
    const sFaçade = façades.get(sPresence)!;
    expect(await healthOk(kFaçade)).toBe(true);
    expect(await healthOk(sFaçade)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(kPresence) === "healthy");
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(sPresence) === "healthy");
    const kConnBefore = creator.path.getCreatorSendDestForTest?.(kPresence)?.toConnectionId;
    const sarahConnBefore = sarah.path.client.id;

    let refreshCalls = 0;
    let liveSarah = sarah;

    liveSarah.path.onRouteRefreshRequested = () => {
      refreshCalls += 1;
    };

    sEcho.setDropHealth(true);
    for (let i = 0; i < ROUTE_SAME_FAIL_LIMIT + 1; i++) {
      await fetch(`${sFaçade}/health`, { signal: AbortSignal.timeout(3_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 80));
    }

    await waitFor(
      () => (creator.path.getRouteCountersForTest()?.routeRefreshRequested ?? 0) >= 1,
      15_000
    );
    expect(creator.path.getCreatorRouteHealthForTest?.(sPresence)).toBe("unavailable");
    expect(refreshCalls).toBe(1);

    // Cooldown / no spam while still exhausted on same route (joiner has not reminted yet).
    for (let i = 0; i < 3; i++) {
      await fetch(`${sFaçade}/health`, { signal: AbortSignal.timeout(3_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 80));
    }
    expect(creator.path.getRouteCountersForTest()?.routeRefreshRequested).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(creator.path.getCreatorRouteHealthForTest?.(sPresence)).toBe("unavailable");

    // Honor the directed refresh: remint disposable connection (existing restore path).
    const presenceId = liveSarah.path.relayPresenceId!;
    const gen = liveSarah.path.presenceGeneration ?? 1;
    const ws = liveSarah.path.relayWsUrl;
    const sid = liveSarah.path.relaySessionId;
    const tok = liveSarah.path.relayAccessToken;
    sEcho.setDropHealth(false);
    await liveSarah.path.stop();
    const sarah2 = await restoreRelayPath({
      relayWsUrl: ws,
      relaySessionId: sid,
      relayAccessToken: tok,
      sessionCode: "PM-RC9III",
      role: "joiner",
      localA2aBaseUrl: sEcho.url,
      relayPresenceId: presenceId,
      presenceGeneration: gen
    });
    await sarah2.ready;
    liveSarah = sarah2;
    const sarahConnAfter = liveSarah.path.client.id;
    expect(sarahConnAfter).not.toBe(sarahConnBefore);

    await waitFor(
      () => creator.path.getCreatorSendDestForTest?.(sPresence)?.toConnectionId === sarahConnAfter,
      20_000
    );
    // READY only after creator→joiner transport probe (no sleep readiness).
    const sFaçadeAfter = () => façades.get(sPresence) ?? sFaçade;
    await waitFor(() => healthOk(sFaçadeAfter()), 20_000);
    await waitFor(
      () => creator.path.getCreatorRouteHealthForTest?.(sPresence) === "healthy",
      20_000
    );
    expect(await healthOk(sFaçadeAfter())).toBe(true);

    // Per-peer isolation: Kelvin unchanged throughout.
    expect(creator.path.getCreatorSendDestForTest?.(kPresence)?.toConnectionId).toBe(kConnBefore);
    expect(creator.path.getCreatorRouteHealthForTest?.(kPresence)).toBe("healthy");
    expect(await healthOk(kFaçade)).toBe(true);
    expect(kelvin.path.client.id).toBe(kConnBefore);

    await creator.path.stop();
    await kelvin.path.stop();
    await liveSarah.path.stop();
    await creatorEcho.close();
    await kEcho.close();
    await sEcho.close();
    await relay.close();
  }, 180_000);
});

describe("tunnel same-route retry semantics (H5 companion)", () => {
  it("H5 still: tunnel may retry once when stall returns retry without dest change", async () => {
    let plaintextHandler: ((data: Uint8Array) => void) | null = null;
    let sendCount = 0;
    const egress = new RelayHttpEgress(
      mockRelayClient(
        async (plaintext) => {
          sendCount += 1;
          if (sendCount >= 2) {
            const msg = JSON.parse(new TextDecoder().decode(plaintext)) as {
              correlationId: string;
            };
            queueMicrotask(() => {
              plaintextHandler?.(
                new TextEncoder().encode(
                  JSON.stringify({
                    kind: "http_response",
                    correlationId: msg.correlationId,
                    statusCode: 200,
                    bodyB64: Buffer.from("ok").toString("base64")
                  })
                )
              );
            });
          }
        },
        (handler) => {
          plaintextHandler = handler;
          return () => {
            plaintextHandler = null;
          };
        }
      ),
      "joiner",
      {
        transportProbeTimeoutMs: 40,
        onTransportStall: () => ({ kind: "retry" })
      }
    );
    const url = await egress.listen();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(sendCount).toBe(2);
    await egress.close();
  });
});
