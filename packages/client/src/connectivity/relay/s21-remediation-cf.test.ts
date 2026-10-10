/**
 * Stage 21 remediation closure — CF unit tests (S21-4-CF1, S21-5-CF1, S21-5-CF2).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createRelayAccessToken,
  createRelaySessionId,
  HostedPairMeshRelay,
  RELAY_MAX_UNATTACHED,
  RELAY_UNATTACHED_TIMEOUT_MS
} from "../index.js";

async function openRaw(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), 5_000);
    socket.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    socket.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  return socket;
}

async function createSession(httpBase: string) {
  const relaySessionId = createRelaySessionId(randomBytes);
  const token = createRelayAccessToken(randomBytes);
  const res = await fetch(`${httpBase}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relaySessionId, relayAccessToken: token })
  });
  expect(res.ok).toBe(true);
  return { relaySessionId, token };
}

async function attach(
  socket: WebSocket,
  session: { relaySessionId: string; token: string },
  connectionId: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("attach timeout")), 5_000);
    const onMsg = (data: WebSocket.RawData) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "attached") {
        clearTimeout(t);
        socket.off("message", onMsg);
        resolve();
      }
      if (frame.type === "error") {
        clearTimeout(t);
        socket.off("message", onMsg);
        reject(new Error(frame.message));
      }
    };
    socket.on("message", onMsg);
    socket.send(
      JSON.stringify({
        version: 1,
        type: "attach",
        relaySessionId: session.relaySessionId,
        relayAccessToken: session.token,
        connectionId
      })
    );
  });
}

describe("S21 remediation CFs", () => {
  it("S21-5-CF1 — unattached budget evicts oldest; legitimate attach still works", async () => {
    const logs: string[] = [];
    const relay = new HostedPairMeshRelay({
      maxConnections: 32,
      maxUnattached: RELAY_MAX_UNATTACHED,
      log: (e) => logs.push(e)
    });
    const { port } = await relay.listen("127.0.0.1", 0);
    const wsUrl = `ws://127.0.0.1:${port}/`;
    const httpBase = `http://127.0.0.1:${port}`;

    const bare: WebSocket[] = [];
    for (let i = 0; i < RELAY_MAX_UNATTACHED; i += 1) {
      bare.push(await openRaw(wsUrl));
    }
    expect(relay.getOpsSnapshot().unattachedConnections).toBe(RELAY_MAX_UNATTACHED);

    // One more open should evict oldest unattached and accept
    const extra = await openRaw(wsUrl);
    expect(relay.getOpsSnapshot().unattachedEvicted).toBeGreaterThanOrEqual(1);
    expect(relay.getOpsSnapshot().unattachedConnections).toBeLessThanOrEqual(RELAY_MAX_UNATTACHED);

    const session = await createSession(httpBase);
    await attach(extra, session, `conn_legit_${randomBytes(3).toString("hex")}`);
    expect(relay.getOpsSnapshot().attachSuccesses).toBeGreaterThanOrEqual(1);

    for (const s of [...bare, extra]) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    await relay.close();
  }, 20_000);

  it("S21-5-CF1 — unattached timeout shorter than legacy 90s", () => {
    expect(RELAY_UNATTACHED_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(RELAY_UNATTACHED_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("S21-4-CF1 — soft backpressure rejects without silent drop", async () => {
    // softBytes=0 forces the reject path deterministically (ba >= 0).
    // Real bufferedAmount growth is covered by S21-4 harness + remote slow-consumer proof.
    const relay = new HostedPairMeshRelay({
      maxConnections: 8,
      backpressureSoftBytes: 0,
      backpressureHardBytes: 4 * 1024 * 1024
    });
    const { port } = await relay.listen("127.0.0.1", 0);
    const wsUrl = `ws://127.0.0.1:${port}/`;
    const httpBase = `http://127.0.0.1:${port}`;
    const session = await createSession(httpBase);

    const a = await openRaw(wsUrl);
    const b = await openRaw(wsUrl);
    const aId = `conn_a_${randomBytes(3).toString("hex")}`;
    const bId = `conn_b_${randomBytes(3).toString("hex")}`;
    await attach(a, session, aId);
    await attach(b, session, bId);

    const errors: Array<{ message: string; detail?: string }> = [];
    a.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "error") {
        errors.push({ message: String(frame.message), detail: frame.detail });
      }
    });

    const ciphertextB64 = Buffer.from(JSON.stringify({ n: 1 }), "utf8").toString("base64");
    a.send(
      JSON.stringify({
        version: 1,
        type: "forward",
        toConnectionId: bId,
        sequence: 1,
        ciphertextB64
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    const snap = relay.getOpsSnapshot();
    expect(snap.destinationBackpressureRejects).toBeGreaterThanOrEqual(1);
    expect(snap.framesForwarded).toBe(0);
    expect(errors.some((e) => e.message === "destination_backpressure" && e.detail === "soft_reject")).toBe(
      true
    );

    a.close();
    b.close();
    await relay.close();
  }, 15_000);

  it("S21-4-CF1 — hard backpressure disconnects slow destination", async () => {
    const relay = new HostedPairMeshRelay({
      maxConnections: 8,
      backpressureSoftBytes: 64 * 1024 * 1024,
      backpressureHardBytes: 0
    });
    const { port } = await relay.listen("127.0.0.1", 0);
    const wsUrl = `ws://127.0.0.1:${port}/`;
    const httpBase = `http://127.0.0.1:${port}`;
    const session = await createSession(httpBase);

    const a = await openRaw(wsUrl);
    const b = await openRaw(wsUrl);
    const aId = `conn_a_${randomBytes(3).toString("hex")}`;
    const bId = `conn_b_${randomBytes(3).toString("hex")}`;
    await attach(a, session, aId);
    await attach(b, session, bId);

    const errors: string[] = [];
    const bClosed = new Promise<void>((resolve) => {
      b.once("close", () => resolve());
    });
    a.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "error") errors.push(String(frame.message));
    });

    a.send(
      JSON.stringify({
        version: 1,
        type: "forward",
        toConnectionId: bId,
        sequence: 1,
        ciphertextB64: Buffer.from("e30=", "utf8").toString("base64")
      })
    );
    await Promise.race([bClosed, new Promise((r) => setTimeout(r, 2000))]);
    const snap = relay.getOpsSnapshot();
    expect(snap.slowConsumerDisconnects).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e === "destination_backpressure")).toBe(true);

    a.close();
    try {
      b.close();
    } catch {
      /* already closed */
    }
    await relay.close();
  }, 15_000);

  it("S21-5-CF2 — auth flood suppresses attach_denied logs", async () => {
    const emitted: string[] = [];
    const relay = new HostedPairMeshRelay({
      maxConnections: 16,
      log: (e) => emitted.push(e)
    });
    const { port } = await relay.listen("127.0.0.1", 0);
    const wsUrl = `ws://127.0.0.1:${port}/`;

    for (let i = 0; i < 30; i += 1) {
      const s = await openRaw(wsUrl);
      s.send(
        JSON.stringify({
          version: 1,
          type: "attach",
          relaySessionId: createRelaySessionId(randomBytes),
          relayAccessToken: createRelayAccessToken(randomBytes),
          connectionId: `conn_bad_${i}_${randomBytes(2).toString("hex")}`
        })
      );
      await new Promise((r) => setTimeout(r, 5));
      s.close();
    }
    await new Promise((r) => setTimeout(r, 100));

    const snap = relay.getOpsSnapshot();
    expect(snap.attachFailures).toBeGreaterThan(10);
    expect(snap.logSuppressed).toBeGreaterThan(0);
    const deniedLogs = emitted.filter((e) => e === "attach_denied").length;
    expect(deniedLogs).toBeLessThan(snap.attachFailures);

    await relay.close();
  }, 30_000);
});
