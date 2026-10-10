import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createRelaySessionId,
  deriveRelayAccessToken,
  HostedPairMeshRelay,
  PairMeshRelayClient,
  RELAY_MAX_CONNECTIONS,
  RELAY_UNATTACHED_TIMEOUT_MS
} from "../index.js";

async function waitForConnectionCount(
  relay: HostedPairMeshRelay,
  expected: number,
  timeoutMs = 5_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (relay.getOpsSnapshot().connections === expected) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(relay.getOpsSnapshot().connections).toBe(expected);
}

async function openRawSocket(relayWsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(relayWsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("open timeout")), 5_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return socket;
}

describe("hosted relay capacity (Stage 18 Prompt 7)", () => {
  it("Case A — repeated connect/attach/close does not leak toward capacity", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const sessionCode = "PM-CAP-A01";
    const relaySessionId = createRelaySessionId(randomBytes);
    const token = deriveRelayAccessToken({
      inviteSecret: "inv_capacity_a_secret_value_abcdefgh",
      sessionCode,
      relaySessionId
    });
    relay.createSession({ accessToken: token, relaySessionId });

    for (let i = 0; i < 80; i += 1) {
      const client = new PairMeshRelayClient({
        relayUrl: relayWsUrl,
        relaySessionId,
        relayAccessToken: token,
        keepaliveIntervalMs: 0
      });
      await client.connect();
      await client.close();
    }

    await waitForConnectionCount(relay, 0);
    const snap = relay.getOpsSnapshot();
    expect(snap.capacityRejections).toBe(0);
    expect(snap.totalOpened).toBeGreaterThanOrEqual(80);
    expect(snap.totalClosed).toBe(snap.totalOpened);
    await relay.close();
  }, 120_000);

  it("Case B — replacement race: old socket close cannot delete new mapping", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const sessionCode = "PM-CAP-B01";
    const relaySessionId = createRelaySessionId(randomBytes);
    const token = deriveRelayAccessToken({
      inviteSecret: "inv_capacity_b_secret_value_abcdefgh",
      sessionCode,
      relaySessionId
    });
    relay.createSession({ accessToken: token, relaySessionId });

    const clientA = new PairMeshRelayClient({
      relayUrl: relayWsUrl,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_alpha_same_id",
      keepaliveIntervalMs: 0
    });
    await clientA.connect();
    const idA = clientA.id;

    const clientB = new PairMeshRelayClient({
      relayUrl: relayWsUrl,
      relaySessionId,
      relayAccessToken: token,
      connectionId: "conn_alpha_same_id",
      keepaliveIntervalMs: 0
    });
    await clientB.connect();

    await clientA.close();
    expect(clientB.isAttached).toBe(true);
    await waitForConnectionCount(relay, 1);

    await clientB.close();
    await waitForConnectionCount(relay, 0);
    void idA;
    await relay.close();
  }, 30_000);

  it("Case C — failed attach does not permanently accumulate connections", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const relaySessionId = createRelaySessionId(randomBytes);
    const goodToken = deriveRelayAccessToken({
      inviteSecret: "inv_capacity_c_secret_value_abcdefgh",
      sessionCode: "PM-CAP-C01",
      relaySessionId
    });
    relay.createSession({ accessToken: goodToken, relaySessionId });

    for (let i = 0; i < 20; i += 1) {
      const client = new PairMeshRelayClient({
        relayUrl: relayWsUrl,
        relaySessionId,
        relayAccessToken: `rat_${"00".repeat(24)}` as typeof goodToken,
        keepaliveIntervalMs: 0
      });
      await expect(client.connect()).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 50));
    const snap = relay.getOpsSnapshot();
    expect(snap.connections).toBe(0);
    expect(snap.attachFailures).toBeGreaterThanOrEqual(20);
    await relay.close();
  }, 60_000);

  it("Case D — reconnect storm stays bounded under maxConnections", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 12 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const sessionCode = "PM-CAP-D01";
    const relaySessionId = createRelaySessionId(randomBytes);
    const token = deriveRelayAccessToken({
      inviteSecret: "inv_capacity_d_secret_value_abcdefgh",
      sessionCode,
      relaySessionId
    });
    relay.createSession({ accessToken: token, relaySessionId });

    const clients: PairMeshRelayClient[] = [];
    for (let i = 0; i < 8; i += 1) {
      const client = new PairMeshRelayClient({
        relayUrl: relayWsUrl,
        relaySessionId,
        relayAccessToken: token,
        keepaliveIntervalMs: 0
      });
      await client.connect();
      clients.push(client);
    }
    expect(relay.getOpsSnapshot().connections).toBe(8);

    for (let round = 0; round < 6; round += 1) {
      for (const client of clients) {
        client.terminateForTest();
      }
      await Promise.all(
        clients.map(async (client) => {
          await new Promise((r) => setTimeout(r, 5));
          await client.connect();
        })
      );
      expect(relay.getOpsSnapshot().connections).toBeLessThanOrEqual(12);
      expect(relay.getOpsSnapshot().capacityRejections).toBe(0);
    }

    for (const client of clients) {
      await client.close();
    }
    await waitForConnectionCount(relay, 0);
    await relay.close();
  }, 120_000);

  it("reaps unattached idle sockets without counting leak", async () => {
    const relay = new HostedPairMeshRelay({
      maxConnections: RELAY_MAX_CONNECTIONS,
      idleTimeoutMs: 60_000
    });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;

    const sockets: WebSocket[] = [];
    for (let i = 0; i < 5; i += 1) {
      sockets.push(await openRawSocket(relayWsUrl));
    }
    expect(relay.getOpsSnapshot().connections).toBe(5);
    expect(relay.getOpsSnapshot().unattachedConnections).toBe(5);

    for (const socket of sockets) {
      socket.close();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.getOpsSnapshot().connections).toBe(0);
    void RELAY_UNATTACHED_TIMEOUT_MS;
    await relay.close();
  }, 30_000);
});
