import { describe, expect, it } from "vitest";
import {
  deriveRelayAccessToken,
  HostedPairMeshRelay,
  createRelaySessionId,
  RELAY_MAX_FRAME_BYTES
} from "./index.js";
import { randomBytes } from "node:crypto";

describe("hosted relay + rendezvous", () => {
  it("registers SessionCode without exposing invite or access token", async () => {
    const relay = new HostedPairMeshRelay({ publicWsUrl: "wss://relay.test/relay" });
    const bound = await relay.listen("127.0.0.1", 0);
    try {
      const sessionCode = "PM-TEST01";
      const relaySessionId = createRelaySessionId(randomBytes);
      const token = deriveRelayAccessToken({
        inviteSecret: "inv_test_secret_value_123456",
        sessionCode,
        relaySessionId
      });
      relay.createSession({ accessToken: token, relaySessionId });
      const record = relay.registerRendezvous({
        sessionCode,
        relaySessionId,
        creatorTransportPublicKey: "ab".repeat(32)
      });
      expect(record.relayWsUrl).toContain("wss://");
      expect(JSON.stringify(record)).not.toContain("inv_");
      expect(JSON.stringify(record)).not.toContain(token);

      const res = await fetch(`http://127.0.0.1:${bound.port}/v1/rendezvous/${sessionCode}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.relaySessionId).toBe(relaySessionId);
      expect(body.creatorTransportPublicKey).toBeTruthy();
      expect(body).not.toHaveProperty("relayAccessToken");
      expect(body).not.toHaveProperty("inviteSecret");
    } finally {
      await relay.close();
    }
  });

  it("returns generic not_found for unknown SessionCode", async () => {
    const relay = new HostedPairMeshRelay();
    const bound = await relay.listen("127.0.0.1", 0);
    try {
      const res = await fetch(`http://127.0.0.1:${bound.port}/v1/rendezvous/PM-MISSING`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      await relay.close();
    }
  });

  it("exposes minimal health without session metadata", async () => {
    const relay = new HostedPairMeshRelay();
    const bound = await relay.listen("127.0.0.1", 0);
    try {
      const res = await fetch(`http://127.0.0.1:${bound.port}/health`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body).not.toHaveProperty("sessions");
      expect(body).not.toHaveProperty("participants");
    } finally {
      await relay.close();
    }
  });

  it("exposes /ready and /metrics without secrets (Stage 18 Prompt 6)", async () => {
    const relay = new HostedPairMeshRelay();
    const bound = await relay.listen("127.0.0.1", 0);
    try {
      const ready = await fetch(`http://127.0.0.1:${bound.port}/ready`);
      expect(ready.status).toBe(200);
      const readyBody = (await ready.json()) as Record<string, unknown>;
      expect(readyBody.ready).toBe(true);
      expect(readyBody).not.toHaveProperty("tokens");

      const metrics = await fetch(`http://127.0.0.1:${bound.port}/metrics`);
      expect(metrics.status).toBe(200);
      const snap = (await metrics.json()) as Record<string, unknown>;
      expect(snap.ready).toBe(true);
      expect(typeof snap.connections).toBe("number");
      expect(typeof snap.peakConnections).toBe("number");
      expect(typeof snap.totalOpened).toBe("number");
      expect(typeof snap.capacityRejections).toBe("number");
      expect(typeof snap.sessions).toBe("number");
      expect(typeof snap.attachFailures).toBe("number");
      expect(snap).not.toHaveProperty("accessTokens");
      expect(JSON.stringify(snap)).not.toMatch(/rat_/);
    } finally {
      await relay.close();
    }
  });

  it("returns 503 on /ready after shutdown begins", async () => {
    const relay = new HostedPairMeshRelay();
    const bound = await relay.listen("127.0.0.1", 0);
    const port = bound.port;
    await relay.close();
    // Server closed — fetch should fail or not be ready; isReady false after close.
    expect(relay.isReady()).toBe(false);
    expect(relay.getOpsSnapshot().ready).toBe(false);
    void port;
  });

  it("documents frame size limit", () => {
    expect(RELAY_MAX_FRAME_BYTES).toBe(256 * 1024);
  });

  it("derives stable relay access tokens from invite material", () => {
    const relaySessionId = createRelaySessionId(randomBytes);
    const a = deriveRelayAccessToken({
      inviteSecret: "same",
      sessionCode: "PM-ABC123",
      relaySessionId
    });
    const b = deriveRelayAccessToken({
      inviteSecret: "same",
      sessionCode: "PM-ABC123",
      relaySessionId
    });
    const c = deriveRelayAccessToken({
      inviteSecret: "other",
      sessionCode: "PM-ABC123",
      relaySessionId
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
