import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  RelayBridge,
  classifyRelayReconnectError,
  nextReconnectDelayMs,
  RELAY_RECONNECT_INITIAL_MS,
  RELAY_RECONNECT_MAX_MS,
  relayRouteFileFromStateFile
} from "./index.js";

async function listenEcho(): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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

function waitFor(predicate: () => boolean, timeoutMs = 15_000, intervalMs = 50): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("relay reconnect policy", () => {
  it("applies exponential ceiling and full jitter bounds", () => {
    expect(nextReconnectDelayMs(0, { random: () => 0 })).toBe(0);
    expect(nextReconnectDelayMs(0, { random: () => 0.999999999 })).toBe(RELAY_RECONNECT_INITIAL_MS);
    expect(nextReconnectDelayMs(10, { random: () => 0.999999999 })).toBe(RELAY_RECONNECT_MAX_MS);
    const mid = nextReconnectDelayMs(3, { random: () => 0.5 });
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(
      Math.min(RELAY_RECONNECT_MAX_MS, RELAY_RECONNECT_INITIAL_MS * 8)
    );
  });

  it("classifies auth vs retryable errors", () => {
    expect(
      classifyRelayReconnectError({
        code: "pairmesh.relay_authentication_failed",
        message: "denied"
      })
    ).toBe("auth");
    expect(
      classifyRelayReconnectError({ code: "pairmesh.relay_unavailable", message: "down" })
    ).toBe("retryable");
    expect(
      classifyRelayReconnectError({
        code: "pairmesh.relay_session_not_found",
        message: "attach_denied"
      })
    ).toBe("retryable");
  });
});

describe("relay auto-reconnect (Prompt 4)", () => {
  it("reconnects after unexpected WS drop without leave/re-pair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-auto-re-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));

    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    const sessionCode = "PM-AUTO01";
    const inviteSecret = "inv_auto_reconnect_secret_value_abcdef12";

    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      // Deterministic tiny backoff for tests
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 20)
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 20)
    });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);
    expect(creatorBridge.getStatus().lifecycle).toBe("ready");
    expect(joinerBridge.getStatus().lifecycle).toBe("ready");

    const endpointBefore = creatorBridge.getLocalEndpoint();
    expect(endpointBefore).toBeTruthy();

    creatorBridge.terminateActiveSocketForTest();
    await waitFor(() => creatorBridge.getStatus().lifecycle === "reconnecting", 5_000);
    await waitFor(() => creatorBridge.getStatus().lifecycle === "ready", 30_000);

    expect(creatorBridge.getStatus().connected).toBe(true);
    expect(creatorBridge.getLocalEndpoint()).toBeTruthy();
    // Fresh tunnel bind after rekey
    expect(creatorBridge.getLocalEndpoint()).not.toBe("");

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("intentional stop prevents reconnect loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-stop-re-"));
    const routeFile = relayRouteFileFromStateFile(join(dir, "state.json"));
    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const echo = await listenEcho();

    const scheduled: number[] = [];
    const bridge = new RelayBridge({
      routeFilePath: routeFile,
      random: () => 0,
      schedule: (fn, ms) => {
        scheduled.push(ms);
        return setTimeout(fn, ms);
      }
    });

    await bridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-STOP1",
      inviteSecret: "inv_stop_reconnect_secret_value_xyz",
      localA2aBaseUrl: echo.url
    });

    await bridge.stop({ clearPersisted: false, intentional: true });
    expect(bridge.getStatus().lifecycle).toBe("stopped");
    const scheduledAfterStop = scheduled.length;
    bridge.terminateActiveSocketForTest();
    await new Promise((r) => setTimeout(r, 100));
    expect(scheduled.length).toBe(scheduledAfterStop);
    expect(bridge.getStatus().lifecycle).toBe("stopped");

    await echo.close();
    await relay.close();
  });

  it("leave clears route and does not resurrect reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-leave-re-"));
    const routeFile = relayRouteFileFromStateFile(join(dir, "state.json"));
    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const echo = await listenEcho();
    const bridge = new RelayBridge({ routeFilePath: routeFile, random: () => 0 });

    await bridge.startCreator({
      relayWsUrl: `ws://127.0.0.1:${port}/relay`,
      sessionCode: "PM-LEAVE1",
      inviteSecret: "inv_leave_reconnect_secret_value_abc",
      localA2aBaseUrl: echo.url
    });
    await bridge.stop({ clearPersisted: true, intentional: true });
    expect(bridge.getStatus().lifecycle).toBe("idle");
    bridge.terminateActiveSocketForTest();
    await new Promise((r) => setTimeout(r, 50));
    expect(["idle", "stopped"]).toContain(bridge.getStatus().lifecycle);

    await echo.close();
    await relay.close();
  });

  it("stale disconnect from prior generation does not tear down new path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-epoch-re-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    const sessionCode = "PM-EPOCH1";
    const inviteSecret = "inv_epoch_reconnect_secret_value_9999";

    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10)
    });
    const joinerBridge = new RelayBridge({ routeFilePath: joinerRoute });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);

    creatorBridge.terminateActiveSocketForTest();
    await waitFor(() => creatorBridge.getStatus().lifecycle === "ready", 30_000);
    const readyEndpoint = creatorBridge.getLocalEndpoint();

    // Second terminate should recover again; epoch isolation keeps lifecycle coherent
    creatorBridge.terminateActiveSocketForTest();
    await waitFor(() => creatorBridge.getStatus().lifecycle === "ready", 30_000);
    expect(creatorBridge.getLocalEndpoint()).toBeTruthy();
    expect(readyEndpoint).toBeTruthy();

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 90_000);
});
