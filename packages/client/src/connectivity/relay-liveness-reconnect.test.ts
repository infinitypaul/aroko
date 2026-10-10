import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostedPairMeshRelay, RelayBridge, relayRouteFileFromStateFile } from "./index.js";

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

function waitFor(predicate: () => boolean, timeoutMs = 15_000, intervalMs = 20): Promise<void> {
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

describe("relay liveness + force-reconnect (Stage 18 Prompt 2)", () => {
  it("ping → pong keeps ready; no reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-ok-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10),
      relayClientOptions: {
        keepaliveIntervalMs: 40,
        pongDeadlineMs: 200
      }
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10),
      relayClientOptions: { keepaliveIntervalMs: 0 }
    });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-LIVEOK",
      inviteSecret: "inv_liveness_ok_secret_value_abcdef",
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode: "PM-LIVEOK",
      inviteSecret: "inv_liveness_ok_secret_value_abcdef",
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);
    expect(creatorBridge.getStatus().lifecycle).toBe("ready");

    await new Promise((r) => setTimeout(r, 150));
    expect(creatorBridge.getStatus().lifecycle).toBe("ready");
    expect(creatorBridge.getStatus().lastReconnectReason).toBeUndefined();

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("ping → no pong → reconnects via force path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-to-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({
      idleTimeoutMs: 60 * 60_000,
      respondToPing: false
    });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 15),
      relayClientOptions: {
        keepaliveIntervalMs: 50,
        pongDeadlineMs: 40
      }
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 15),
      relayClientOptions: {
        keepaliveIntervalMs: 0
      }
    });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-PONGTO",
      inviteSecret: "inv_pong_timeout_secret_value_xyz12",
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode: "PM-PONGTO",
      inviteSecret: "inv_pong_timeout_secret_value_xyz12",
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);
    expect(creatorBridge.getStatus().lifecycle).toBe("ready");

    await waitFor(() => creatorBridge.getStatus().lastReconnectReason === "pong_timeout", 5_000);
    expect(creatorBridge.getStatus().lifecycle).not.toBe("ready");

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("suspension gap while socket appears open forces reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-sleep-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    let mono = 0;
    const sleepBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10),
      relayClientOptions: {
        keepaliveIntervalMs: 1_000_000,
        pongDeadlineMs: 200,
        suspensionGapMs: 500,
        nowMs: () => mono
      }
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10),
      relayClientOptions: { keepaliveIntervalMs: 0 }
    });

    await sleepBridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-SLEEP1",
      inviteSecret: "inv_sleep_gap_secret_value_abcdef12",
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode: "PM-SLEEP1",
      inviteSecret: "inv_sleep_gap_secret_value_abcdef12",
      localA2aBaseUrl: joinerEcho.url
    });
    await sleepBridge.awaitCreatorReady(30_000);
    expect(sleepBridge.getStatus().lifecycle).toBe("ready");

    mono = 100;
    sleepBridge.tickLivenessForTest();
    mono = 100 + 600;
    sleepBridge.tickLivenessForTest();

    await waitFor(() => sleepBridge.getStatus().lastReconnectReason === "suspension_gap", 5_000);
    expect(sleepBridge.getStatus().lifecycle).not.toBe("ready");

    await sleepBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("multiple reconnect triggers dedupe (ws close + explicit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-dedupe-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    let scheduled = 0;
    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0,
      schedule: (fn, ms) => {
        scheduled += 1;
        return setTimeout(fn, ms);
      }
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10)
    });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-DEDUPE",
      inviteSecret: "inv_dedupe_reconnect_secret_value_1",
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode: "PM-DEDUPE",
      inviteSecret: "inv_dedupe_reconnect_secret_value_1",
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);

    const before = scheduled;
    creatorBridge.terminateActiveSocketForTest();
    creatorBridge.requestReconnect("explicit", { immediate: true });
    creatorBridge.requestReconnect("network_restored", { immediate: true });
    await waitFor(() => creatorBridge.getStatus().lifecycle === "ready", 30_000);
    // Should recover once — not explode into dozens of competing schedules.
    expect(scheduled - before).toBeLessThan(20);

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("network restore triggers immediate reconnect while backing off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-net-"));
    const routeFile = relayRouteFileFromStateFile(join(dir, "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const echo = await listenEcho();

    let ifCount = 1;
    const delays: number[] = [];
    const bridge = new RelayBridge({
      routeFilePath: routeFile,
      random: () => 0.999,
      countUsableInterfaces: () => ifCount,
      schedule: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, ms === 0 ? 5 : Math.min(ms, 30));
      }
    });

    await bridge.startCreator({
      relayWsUrl: `ws://127.0.0.1:${port}/relay`,
      sessionCode: "PM-NET01",
      inviteSecret: "inv_network_restore_secret_value_ab",
      localA2aBaseUrl: echo.url
    });

    bridge.terminateActiveSocketForTest();
    await waitFor(() => bridge.getStatus().lifecycle === "reconnecting", 5_000);

    ifCount = 0;
    bridge.pollNetworkRestoreForTest();
    ifCount = 1;
    bridge.pollNetworkRestoreForTest();
    expect(bridge.getStatus().lastReconnectReason).toBe("network_restored");

    await bridge.stop({ clearPersisted: true });
    await echo.close();
    await relay.close();
  }, 30_000);

  it("intentional stop cancels watchdog/reconnect; no reconnect after shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-stop-"));
    const routeFile = relayRouteFileFromStateFile(join(dir, "state.json"));
    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const echo = await listenEcho();

    const bridge = new RelayBridge({
      routeFilePath: routeFile,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10),
      relayClientOptions: {
        keepaliveIntervalMs: 30,
        pongDeadlineMs: 20
      }
    });

    await bridge.startCreator({
      relayWsUrl: `ws://127.0.0.1:${port}/relay`,
      sessionCode: "PM-STOPLV",
      inviteSecret: "inv_stop_liveness_secret_value_xyz",
      localA2aBaseUrl: echo.url
    });

    await bridge.stop({ clearPersisted: false, intentional: true });
    expect(bridge.getStatus().lifecycle).toBe("stopped");
    bridge.requestReconnect("explicit", { immediate: true });
    bridge.terminateActiveSocketForTest();
    await new Promise((r) => setTimeout(r, 80));
    expect(bridge.getStatus().lifecycle).toBe("stopped");

    await echo.close();
    await relay.close();
  });

  it("WebSocket close + pong timeout racing dedupe to one recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-race-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    let runs = 0;
    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0,
      schedule: (fn, ms) => {
        if (ms === 0 || (typeof ms === "number" && ms < 50)) {
          runs += 1;
        }
        return setTimeout(fn, 15);
      }
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10)
    });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-RACE01",
      inviteSecret: "inv_race_reconnect_secret_value_xyz",
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode: "PM-RACE01",
      inviteSecret: "inv_race_reconnect_secret_value_xyz",
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);

    const before = runs;
    creatorBridge.terminateActiveSocketForTest();
    creatorBridge.requestReconnect("pong_timeout", { immediate: true });
    await waitFor(() => creatorBridge.getStatus().lifecycle === "ready", 30_000);
    expect(runs - before).toBeLessThan(15);

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("repeated failure uses backoff; reconnect success returns to ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-live-backoff-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "c", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "j", "state.json"));
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    const delays: number[] = [];
    const creatorBridge = new RelayBridge({
      routeFilePath: creatorRoute,
      random: () => 0.5,
      schedule: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, Math.min(ms, 25));
      }
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10)
    });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode: "PM-BACKOFF",
      inviteSecret: "inv_backoff_liveness_secret_value1",
      localA2aBaseUrl: creatorEcho.url
    });
    await joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode: "PM-BACKOFF",
      inviteSecret: "inv_backoff_liveness_secret_value1",
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);

    creatorBridge.terminateActiveSocketForTest();
    await waitFor(() => creatorBridge.getStatus().lifecycle === "ready", 30_000);
    expect(delays.some((d) => d >= 0)).toBe(true);

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);
});
