/**
 * Stage 18 Prompt 7 — Connection route state machine:
 *   unbound → discovered → verifying → healthy (verified)
 *
 * Deterministic proofs for verify-after-remint + isolation (no sleep readiness).
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  isRouteVerifying,
  restoreRelayPath,
  ROUTE_SAME_COOLDOWN_MS,
  ROUTE_SAME_FAIL_LIMIT,
  startCreatorRelayPath,
  startJoinerRelayPath
} from "./index.js";

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

async function listenControllableEcho(): Promise<{
  url: string;
  setDropHealth: (drop: boolean) => void;
  close: () => Promise<void>;
}> {
  let dropHealth = false;
  const server = createServer((req, res) => {
    if (dropHealth && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", ok: true }));
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

describe("route state machine (discovered → verifying → verified)", () => {
  it("SM1: discovered before ingress stays verifying; early miss keeps pending; exactly one rebind_succeeded", async () => {
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
      sessionCode: "PM-SM1AAA",
      inviteSecret: "inv_sm1_discovered_before_ingress_secret_aa",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 200,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-SM1AAA",
      inviteSecret: "inv_sm1_discovered_before_ingress_secret_aa",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    const presenceId = joiner.path.relayPresenceId!;
    expect(await healthOk(façade)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(presenceId) === "healthy");
    const gen = joiner.path.presenceGeneration ?? 1;
    const oldConn = joiner.path.client.id;

    await joiner.path.stop();

    const remint = await restoreRelayPath(
      {
        relayWsUrl: joiner.path.relayWsUrl,
        relaySessionId: joiner.path.relaySessionId,
        relayAccessToken: joiner.path.relayAccessToken,
        sessionCode: "PM-SM1AAA",
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
    expect(creator.path.getCreatorPendingVerifyForTest?.(presenceId)).toBe(true);
    expect(creator.path.getCreatorRouteHealthForTest?.(presenceId)).not.toBe("healthy");

    const ac = new AbortController();
    const probe = fetch(`${façade}/health`, { signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await probe;

    expect(creator.path.getCreatorPendingVerifyForTest?.(presenceId)).toBe(true);
    expect(isRouteVerifying(creator.path.getCreatorRouteHealthForTest?.(presenceId))).toBe(true);

    const successBefore = creator.path.getRouteCountersForTest?.()?.routeRebindSuccess ?? 0;

    releaseIngress();
    await remint.ready;
    await waitFor(() => healthOk(façade));
    await waitFor(
      () => creator.path.getCreatorRouteHealthForTest?.(presenceId) === "healthy",
      15_000
    );

    expect(creator.path.getCreatorPendingVerifyForTest?.(presenceId)).toBe(false);
    expect(creator.path.getRouteCountersForTest?.()?.routeRebindSuccess).toBe(successBefore + 1);
    expect(await healthOk(façade)).toBe(true);
    expect(creator.path.getRouteCountersForTest?.()?.routeRebindSuccess).toBe(successBefore + 1);

    await creator.path.stop();
    await remint.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 90_000);

  it("SM2: bounded verifying failures reach terminal + refresh_requested", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenControllableEcho();
    let façade = "";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-SM2BBB",
      inviteSecret: "inv_sm2_bounded_verify_exhaust_secret_bb",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 80,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-SM2BBB",
      inviteSecret: "inv_sm2_bounded_verify_exhaust_secret_bb",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    const presenceId = joiner.path.relayPresenceId!;

    joinerEcho.setDropHealth(true);
    expect(creator.path.getCreatorPendingVerifyForTest?.(presenceId)).toBe(true);
    expect(isRouteVerifying(creator.path.getCreatorRouteHealthForTest?.(presenceId))).toBe(true);

    const refreshBefore = creator.path.getRouteCountersForTest?.()?.routeRefreshRequested ?? 0;

    for (let i = 0; i < ROUTE_SAME_FAIL_LIMIT + 2; i++) {
      await fetch(`${façade}/health`, { signal: AbortSignal.timeout(2_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 40));
    }

    expect(creator.path.getCreatorRouteHealthForTest?.(presenceId)).toBe("unavailable");
    expect(creator.path.getCreatorPendingVerifyForTest?.(presenceId)).toBe(false);
    const after = creator.path.getRouteCountersForTest?.();
    expect(after?.routeVerificationFailed ?? 0).toBeGreaterThanOrEqual(ROUTE_SAME_FAIL_LIMIT);
    expect(after?.routeRefreshRequested ?? 0).toBeGreaterThan(refreshBefore);
    expect(after?.routeSuspect ?? 0).toBeLessThan(20);
    expect(after?.routeRebindSuccess ?? 0).toBe(0);

    joinerEcho.setDropHealth(false);
    await joinerEcho.close();
    await creator.path.stop();
    await joiner.path.stop();
    await creatorEcho.close();
    await relay.close();
  }, 90_000);

  it("SM3: Sarah verifying failure leaves Kelvin healthy (per-peer isolation)", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const kelvinEcho = await listenEcho();
    const sarahEcho = await listenControllableEcho();
    const façades = new Map<string, string>();

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-SM3CCC",
      inviteSecret: "inv_sm3_per_peer_isolation_secret_cc",
      localA2aBaseUrl: creatorEcho.url,
      transportProbeTimeoutMs: 80,
      onPeerEndpoint: (ev) => {
        façades.set(ev.relayParticipantId, ev.localEndpoint);
      }
    });
    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-SM3CCC",
      inviteSecret: "inv_sm3_per_peer_isolation_secret_cc",
      localA2aBaseUrl: kelvinEcho.url
    });
    await creator.ready;
    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-SM3CCC",
      inviteSecret: "inv_sm3_per_peer_isolation_secret_cc",
      localA2aBaseUrl: sarahEcho.url
    });
    await waitFor(() => façades.size >= 2, 30_000);
    const kelvinId = kelvin.path.relayPresenceId!;
    const sarahId = sarah.path.relayPresenceId!;
    expect(sarahId).not.toBe(kelvinId);

    expect(await healthOk(façades.get(kelvinId)!)).toBe(true);
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(kelvinId) === "healthy");
    sarahEcho.setDropHealth(true);
    expect(creator.path.getCreatorPendingVerifyForTest?.(sarahId)).toBe(true);

    const sarahFaçade = façades.get(sarahId)!;
    for (let i = 0; i < ROUTE_SAME_FAIL_LIMIT + 1; i++) {
      await fetch(`${sarahFaçade}/health`, { signal: AbortSignal.timeout(2_000) }).catch(
        () => undefined
      );
      await new Promise((r) => setTimeout(r, ROUTE_SAME_COOLDOWN_MS + 40));
    }

    expect(creator.path.getCreatorRouteHealthForTest?.(sarahId)).toBe("unavailable");
    expect(creator.path.getCreatorRouteHealthForTest?.(kelvinId)).toBe("healthy");
    expect(await healthOk(façades.get(kelvinId)!)).toBe(true);

    sarahEcho.setDropHealth(false);
    await sarahEcho.close();
    await creator.path.stop();
    await kelvin.path.stop();
    await sarah.path.stop();
    await creatorEcho.close();
    await kelvinEcho.close();
    await relay.close();
  }, 90_000);

  it("SM4: initial bind verifies once; steady-state healthy probes ≠ rebind_succeeded", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    let façade = "";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-SM4DDD",
      inviteSecret: "inv_sm4_initial_verify_distinct_secret_dd",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-SM4DDD",
      inviteSecret: "inv_sm4_initial_verify_distinct_secret_dd",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    const presenceId = joiner.path.relayPresenceId!;

    await waitFor(() => healthOk(façade));
    await waitFor(() => creator.path.getCreatorRouteHealthForTest?.(presenceId) === "healthy");
    const successAfterVerify = creator.path.getRouteCountersForTest?.()?.routeRebindSuccess ?? 0;
    expect(successAfterVerify).toBeGreaterThanOrEqual(1);
    expect(creator.path.getCreatorPendingVerifyForTest?.(presenceId)).toBe(false);

    for (let i = 0; i < 3; i++) {
      expect(await healthOk(façade)).toBe(true);
    }
    expect(creator.path.getRouteCountersForTest?.()?.routeRebindSuccess).toBe(successAfterVerify);

    await creator.path.stop();
    await joiner.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 90_000);
});
