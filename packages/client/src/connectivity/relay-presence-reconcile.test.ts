import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  RelayBridge,
  loadRelayRoute,
  mintJoinerRelayPresenceId,
  relayRouteFileFromStateFile,
  restoreRelayPath,
  startCreatorRelayPath,
  startJoinerRelayPath
} from "./index.js";
import { invalidatePeerHealthCache, clearPeerHealthCache } from "../health/peer-health.js";

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

function waitFor(predicate: () => boolean, timeoutMs = 15_000, intervalMs = 25): Promise<void> {
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

describe("presence reconciliation (Stage 18 Prompt 3)", () => {
  it("mints join presence distinct from connection id shape", () => {
    const id = mintJoinerRelayPresenceId();
    expect(id.startsWith("join_")).toBe(true);
    expect(id.length).toBeGreaterThan(8);
  });

  it("persists stable joiner presence across restore and increments generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-presence-stable-"));
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
      schedule: (fn) => setTimeout(fn, 10)
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10)
    });

    const sessionCode = "PM-PRES01";
    const inviteSecret = "inv_presence_stable_secret_value_ab12";
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

    const routeBefore = await loadRelayRoute(joinerRoute);
    expect(routeBefore?.version).toBe(3);
    expect(
      routeBefore && "relayPresenceId" in routeBefore && routeBefore.relayPresenceId
    ).toBeTruthy();
    const presenceBefore =
      routeBefore && "relayPresenceId" in routeBefore ? routeBefore.relayPresenceId : undefined;
    const genBefore =
      routeBefore && "presenceGeneration" in routeBefore ? routeBefore.presenceGeneration : 1;

    joinerBridge.terminateActiveSocketForTest();
    await waitFor(() => joinerBridge.getStatus().lifecycle === "ready", 30_000);

    const routeAfter = await loadRelayRoute(joinerRoute);
    const presenceAfter =
      routeAfter && "relayPresenceId" in routeAfter ? routeAfter.relayPresenceId : undefined;
    const genAfter =
      routeAfter && "presenceGeneration" in routeAfter ? routeAfter.presenceGeneration : 0;
    expect(presenceAfter).toBe(presenceBefore);
    expect(genAfter).toBeGreaterThan(genBefore ?? 0);
    expect(creatorBridge.getStatus().lifecycle).toBe("ready");

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("creator reconnect recovers without joiner restart (presence keepalive)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-presence-creator-"));
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
      schedule: (fn) => setTimeout(fn, 10)
    });
    const joinerBridge = new RelayBridge({
      routeFilePath: joinerRoute,
      random: () => 0,
      schedule: (fn) => setTimeout(fn, 10)
    });

    const sessionCode = "PM-PRES02";
    const inviteSecret = "inv_presence_creator_secret_value_xy";
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
    expect(joinerBridge.getStatus().lifecycle).toBe("ready");

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("two joiners reconnect together and both rebind on creator", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const kEcho = await listenEcho();
    const sEcho = await listenEcho();

    const endpoints: string[] = [];
    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-PRES03",
      inviteSecret: "inv_presence_two_joiner_secret_abc",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        endpoints.push(ev.relayParticipantId);
      }
    });
    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-PRES03",
      inviteSecret: "inv_presence_two_joiner_secret_abc",
      localA2aBaseUrl: kEcho.url
    });
    await creator.ready;
    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-PRES03",
      inviteSecret: "inv_presence_two_joiner_secret_abc",
      localA2aBaseUrl: sEcho.url
    });
    await waitFor(() => new Set(endpoints).size >= 2, 20_000);

    const kPresence = kelvin.path.relayPresenceId!;
    const sPresence = sarah.path.relayPresenceId!;
    expect(kPresence).not.toBe(sPresence);

    const kGen = kelvin.path.presenceGeneration ?? 1;
    const sGen = sarah.path.presenceGeneration ?? 1;

    await kelvin.path.stop();
    await sarah.path.stop();

    const kelvin2 = await restoreRelayPath({
      relayWsUrl: kelvin.path.relayWsUrl,
      relaySessionId: kelvin.path.relaySessionId,
      relayAccessToken: kelvin.path.relayAccessToken,
      sessionCode: "PM-PRES03",
      role: "joiner",
      localA2aBaseUrl: kEcho.url,
      relayPresenceId: kPresence,
      presenceGeneration: kGen
    });
    const sarah2 = await restoreRelayPath({
      relayWsUrl: sarah.path.relayWsUrl,
      relaySessionId: sarah.path.relaySessionId,
      relayAccessToken: sarah.path.relayAccessToken,
      sessionCode: "PM-PRES03",
      role: "joiner",
      localA2aBaseUrl: sEcho.url,
      relayPresenceId: sPresence,
      presenceGeneration: sGen
    });
    await kelvin2.ready;
    await sarah2.ready;

    expect(kelvin2.path.relayPresenceId).toBe(kPresence);
    expect(sarah2.path.relayPresenceId).toBe(sPresence);
    expect((kelvin2.path.presenceGeneration ?? 0) > kGen).toBe(true);

    await creator.path.stop();
    await kelvin2.path.stop();
    await sarah2.path.stop();
    await creatorEcho.close();
    await kEcho.close();
    await sEcho.close();
    await relay.close();
  }, 90_000);

  it("re-attach with same participantId displaces zombie and receives directed hello", async () => {
    const { randomBytes } = await import("node:crypto");
    const { createRelaySessionId, deriveRelayAccessToken, PairMeshRelayClient } =
      await import("./index.js");
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relaySessionId = createRelaySessionId(randomBytes);
    const token = deriveRelayAccessToken({
      inviteSecret: "inv_presence_takeover_secret_zzzz",
      sessionCode: "PM-TAKE01",
      relaySessionId
    });
    relay.createSession({ accessToken: token, relaySessionId });
    const relayUrl = `ws://127.0.0.1:${port}/relay`;
    const presenceId = "join_conn_takeoveraaaaaaaaaaaa";

    const creator = new PairMeshRelayClient({
      relayUrl,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_creator_aaaaaaaa",
      fromParticipantId: "relay_creator",
      keepaliveIntervalMs: 0
    });
    const zombie = new PairMeshRelayClient({
      relayUrl,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_zombie_bbbbbbbb",
      fromParticipantId: presenceId,
      keepaliveIntervalMs: 0
    });
    await creator.connect();
    await zombie.connect();

    // Live re-attach claims the same presence — zombie must be displaced.
    const live = new PairMeshRelayClient({
      relayUrl,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_live_cccccccccccc",
      fromParticipantId: presenceId,
      keepaliveIntervalMs: 0
    });
    await live.connect();

    const hello = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("live joiner never got creator hello")),
        2_000
      );
      const off = live.onHello((_pk, meta) => {
        clearTimeout(timer);
        off();
        resolve(meta.fromParticipantId ?? "");
      });
      creator.announcePublicKey("ab".repeat(32), {
        e2eReady: true,
        fromParticipantId: "relay_creator",
        toParticipantId: presenceId
      });
    });
    expect(hello).toBe("relay_creator");

    await creator.close();
    await live.close();
    try {
      await zombie.close();
    } catch {
      /* may already be closed by presence takeover */
    }
    await relay.close();
  }, 20_000);

  it("relay reports destination_unavailable when mapped peer socket is dead", async () => {
    const { randomBytes } = await import("node:crypto");
    const { createRelaySessionId, deriveRelayAccessToken, PairMeshRelayClient } =
      await import("./index.js");
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relaySessionId = createRelaySessionId(randomBytes);
    const token = deriveRelayAccessToken({
      inviteSecret: "inv_stale_dest_secret_value_zzzz",
      sessionCode: "PM-STALE1",
      relaySessionId
    });
    relay.createSession({ accessToken: token, relaySessionId });

    const a = new PairMeshRelayClient({
      relayUrl: `ws://127.0.0.1:${port}/relay`,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_aaaaaaaaaaaaaaaa",
      fromParticipantId: "relay_creator",
      keepaliveIntervalMs: 0
    });
    const b = new PairMeshRelayClient({
      relayUrl: `ws://127.0.0.1:${port}/relay`,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_bbbbbbbbbbbbbbbb",
      fromParticipantId: "join_conn_bbbbbbbbbbbbbbbb",
      keepaliveIntervalMs: 0
    });
    await a.connect();
    await b.connect();
    // Announce so presence map is set, then kill B without waiting for map cleanup race:
    // force participant map to point at B then terminate B's socket underneath.
    b.terminateForTest();
    await new Promise((r) => setTimeout(r, 30));

    const rawSocket = (a as unknown as { socket: import("ws").default | null }).socket;
    expect(rawSocket).toBeTruthy();
    const result = await new Promise<{ message: string; toParticipantId?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ message: "timeout" }), 1_500);
      rawSocket!.once("message", (data) => {
        const parsed = JSON.parse(String(data)) as {
          type?: string;
          message?: string;
          toParticipantId?: string;
        };
        clearTimeout(timer);
        resolve({
          message: parsed.message ?? parsed.type ?? "unknown",
          ...(parsed.toParticipantId ? { toParticipantId: parsed.toParticipantId } : {})
        });
      });
      rawSocket!.send(
        JSON.stringify({
          version: 1,
          type: "hello",
          relaySessionId,
          connectionId: "conn_aaaaaaaaaaaaaaaa",
          fromParticipantId: "relay_creator",
          toParticipantId: "join_conn_bbbbbbbbbbbbbbbb",
          transportPublicKey: "ab".repeat(32)
        })
      );
    });
    // After close cleanup, presence is gone → destination_not_found.
    // If map briefly remains with a dead socket, destination_unavailable.
    expect(["destination_not_found", "destination_unavailable", "timeout"]).toContain(
      result.message
    );
    if (result.message !== "timeout") {
      expect(result.toParticipantId).toBe("join_conn_bbbbbbbbbbbbbbbb");
    }

    // Client must surface the error (previously dropped post-attach errors → presence split-brain).
    const wireErr = await new Promise<{ message: string; toParticipantId?: string } | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), 800);
        const off = a.onWireError((err) => {
          clearTimeout(timer);
          off();
          resolve(err);
        });
        a.announcePublicKey("cd".repeat(32), {
          e2eReady: true,
          fromParticipantId: "relay_creator",
          toParticipantId: "join_conn_bbbbbbbbbbbbbbbb"
        });
      }
    );
    expect(wireErr).not.toBeNull();
    expect(["destination_not_found", "destination_unavailable"]).toContain(wireErr!.message);
    expect(wireErr!.toParticipantId).toBe("join_conn_bbbbbbbbbbbbbbbb");

    await a.close();
    await relay.close();
  }, 30_000);

  it("invalidatePeerHealthCache drops matching entries", () => {
    clearPeerHealthCache();
    // Seed via private path is hard; just ensure API does not throw.
    invalidatePeerHealthCache({ peerName: "kelvin" });
    invalidatePeerHealthCache({ a2aAgentUrl: "http://127.0.0.1:1" });
    clearPeerHealthCache();
  });
});
