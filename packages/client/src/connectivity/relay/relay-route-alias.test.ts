import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createRelaySessionId,
  deriveRelayAccessToken,
  HostedPairMeshRelay,
  isRelayWebSocketPath,
  PairMeshRelayClient
} from "../index.js";

async function attachViaUrl(
  relay: HostedPairMeshRelay,
  relayWsUrl: string
): Promise<{ attached: boolean; connectionId?: string }> {
  const sessionCode = "PM-RTAL01";
  const relaySessionId = createRelaySessionId(randomBytes);
  const token = deriveRelayAccessToken({
    inviteSecret: "inv_route_alias_secret_value_1234567890",
    sessionCode,
    relaySessionId
  });
  relay.createSession({ accessToken: token, relaySessionId });

  const client = new PairMeshRelayClient({
    relayUrl: relayWsUrl,
    relaySessionId,
    relayAccessToken: token,
    keepaliveIntervalMs: 0
  });
  await client.connect();
  const attached = client.isAttached;
  const connectionId = client.id;
  await client.close();
  return { attached, connectionId };
}

async function expectWsRejected(url: string): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expected rejection timeout")), 3_000);
    socket.once("open", () => {
      clearTimeout(timer);
      reject(new Error("unexpected open"));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    socket.close();
  } catch {
    // already closed
  }
}

describe("hosted relay WebSocket route alias (Stage 18 Prompt 7)", () => {
  it("isRelayWebSocketPath accepts / and /relay only", () => {
    expect(isRelayWebSocketPath("/")).toBe(true);
    expect(isRelayWebSocketPath("/relay")).toBe(true);
    expect(isRelayWebSocketPath("/foo")).toBe(false);
    expect(isRelayWebSocketPath("/anything")).toBe(false);
  });

  it("A — root WebSocket connects and completes attach", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const result = await attachViaUrl(relay, `ws://127.0.0.1:${port}/`);
    expect(result.attached).toBe(true);
    expect(result.connectionId).toBeTruthy();
    await relay.close();
  });

  it("B — legacy /relay continues to connect and attach", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const result = await attachViaUrl(relay, `ws://127.0.0.1:${port}/relay`);
    expect(result.attached).toBe(true);
    expect(result.connectionId).toBeTruthy();
    await relay.close();
  });

  it("C — root and /relay share capacity accounting", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const root = await attachViaUrl(relay, `ws://127.0.0.1:${port}/`);
    const legacy = await attachViaUrl(relay, `ws://127.0.0.1:${port}/relay`);
    expect(root.attached).toBe(true);
    expect(legacy.attached).toBe(true);
    const start = Date.now();
    while (Date.now() - start < 3_000 && relay.getOpsSnapshot().connections > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const snap = relay.getOpsSnapshot();
    expect(snap.connections).toBe(0);
    expect(snap.attachSuccesses).toBeGreaterThanOrEqual(2);
    expect(snap.attachFailures).toBe(0);
    await relay.close();
  });

  it("D — unknown WebSocket paths are rejected", async () => {
    const relay = new HostedPairMeshRelay({ maxConnections: 8 });
    const { port } = await relay.listen("127.0.0.1", 0);
    await expectWsRejected(`ws://127.0.0.1:${port}/foo`);
    await expectWsRejected(`ws://127.0.0.1:${port}/anything`);
    expect(relay.getOpsSnapshot().connections).toBe(0);
    await relay.close();
  });

  it("E — HTTP /health /ready /metrics remain available alongside root WS", async () => {
    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    const rootHttp = await fetch(`${base}/`);
    expect(rootHttp.status).toBe(200);
    await relay.close();
  });
});
