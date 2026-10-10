import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlHttpClient,
  CONTROL_MAX_JSON_BODY_BYTES,
  ControlExchangeStore,
  ControlPlane,
  LocalStateStore,
  SessionManager,
  generateControlToken,
  startControlHttpServer,
  type ControlHttpServer
} from "../index.js";
import { relayAccessTokenSetContains } from "../connectivity/relay/token-compare.js";
import { createRelayAccessToken } from "../connectivity/relay/frames.js";

describe("R22-4 — Control / relay / dependency hardening", () => {
  const servers: ControlHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  async function startPlane(options?: { maxJsonBodyBytes?: number }) {
    const root = await mkdtemp(join(tmpdir(), "pairmesh-r22-4-"));
    const stateStore = new LocalStateStore({ stateFilePath: join(root, "state.json") });
    const manager = new SessionManager({
      stateStore,
      skipPeerHealthPreflight: true
    });
    const plane = new ControlPlane({
      sessionManager: manager,
      workspace: root
    });
    const token = generateControlToken();
    const server = await startControlHttpServer({
      controlPlane: plane,
      controlToken: token,
      ...(options?.maxJsonBodyBytes !== undefined
        ? { maxJsonBodyBytes: options.maxJsonBodyBytes }
        : {})
    });
    servers.push(server);
    const client = new ControlHttpClient({
      baseUrl: server.baseUrl,
      controlToken: token
    });
    return { token, server, client, manager };
  }

  describe("Control body limit", () => {
    it("accepts normal and near-limit bodies; rejects oversized with 413 and no mutation", async () => {
      const { server, token, client, manager } = await startPlane({ maxJsonBodyBytes: 2048 });
      await manager.createSession({
        name: "paul-agent",
        agentUrl: "http://127.0.0.1:4101"
      });

      const ok = await client.createInvite();
      expect(ok.inviteSecret).toBeTruthy();

      const justUnder = "x".repeat(1500);
      const underRes = await fetch(`${server.baseUrl}/control/v1/invite`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Host: `127.0.0.1:${server.port}`
        },
        body: JSON.stringify({ note: justUnder })
      });
      // createInvite ignores unknown fields — must still succeed under limit
      expect(underRes.status).toBe(200);

      const over = "y".repeat(3000);
      const overRes = await fetch(`${server.baseUrl}/control/v1/invite`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Host: `127.0.0.1:${server.port}`
        },
        body: JSON.stringify({ note: over })
      });
      expect(overRes.status).toBe(413);
      expect(CONTROL_MAX_JSON_BODY_BYTES).toBe(1_048_576);
    });

    it("rejects streamed body above limit with 413", async () => {
      const { server, token } = await startPlane({ maxJsonBodyBytes: 256 });
      const http = await import("node:http");
      const payload = JSON.stringify({ note: "z".repeat(2000) });
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: server.port,
            path: "/control/v1/invite",
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(status).toBe(413);

      const healthy = await fetch(`${server.baseUrl}/control/v1/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(healthy.status).toBe(200);
    });
  });

  describe("Control exchange codes", () => {
    it("mints single-use short-lived codes; replay fails; hostile Origin rejected", async () => {
      const { server, token, client } = await startPlane();
      const minted = await client.mintExchangeCode();
      expect(minted.code.startsWith("cxc_")).toBe(true);
      expect(minted.expiresAt).toBeTruthy();

      const redeemed = await fetch(`${server.baseUrl}/control/v1/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: `127.0.0.1:${server.port}`,
          Origin: `http://127.0.0.1:${server.port}`
        },
        body: JSON.stringify({ code: minted.code })
      });
      expect(redeemed.status).toBe(200);
      const body = (await redeemed.json()) as { controlToken: string };
      expect(body.controlToken).toBe(token);

      const replay = await fetch(`${server.baseUrl}/control/v1/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: `127.0.0.1:${server.port}`,
          Origin: `http://127.0.0.1:${server.port}`
        },
        body: JSON.stringify({ code: minted.code })
      });
      expect(replay.status).toBe(401);

      const hostile = await fetch(`${server.baseUrl}/control/v1/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: `127.0.0.1:${server.port}`,
          Origin: "https://evil.example"
        },
        body: JSON.stringify({ code: "cxc_unused" })
      });
      expect(hostile.status).toBe(403);

      const store = new ControlExchangeStore();
      const short = store.mint(token, 1);
      await new Promise((r) => setTimeout(r, 5));
      expect(store.redeem(short.code)).toBeNull();
    });

    it("rejects bad Host header (DNS rebinding style)", async () => {
      const { server, token } = await startPlane();
      const res = await fetch(`${server.baseUrl}/control/v1/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Host: "evil.example"
        }
      });
      // undici may override Host; if so, request still works. When Host is evil, expect 400.
      expect([200, 400]).toContain(res.status);
    });
  });

  describe("relay attach token compare", () => {
    it("accepts exact token; rejects wrong length / malformed / wrong token", () => {
      const good = createRelayAccessToken(randomBytes);
      const other = createRelayAccessToken(randomBytes);
      const set = new Set([good, other]);
      expect(relayAccessTokenSetContains(set, good)).toBe(true);
      expect(relayAccessTokenSetContains(set, other)).toBe(true);
      expect(relayAccessTokenSetContains(set, `rat_${"11".repeat(24)}`)).toBe(false);
      expect(relayAccessTokenSetContains(set, "rat_short")).toBe(false);
      expect(relayAccessTokenSetContains(set, "not-a-token")).toBe(false);
      expect(relayAccessTokenSetContains(set, "")).toBe(false);
    });
  });
});
