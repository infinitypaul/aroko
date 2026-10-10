import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  RelayBridge,
  clearRelayRoute,
  createRelaySessionId,
  deriveRelayAccessToken,
  loadRelayRoute,
  relayRouteFileFromStateFile,
  restoreRelayPath,
  startCreatorRelayPath,
  startJoinerRelayPath
} from "./index.js";
import { randomBytes } from "node:crypto";

const QUESTION = "QUESTION_CANARY_restart_reconnect";
const ANSWER = "ANSWER_CANARY_after_restore";

async function listenEcho(): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: body, summary: ANSWER }));
    });
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

async function waitForVerifiedTunnel(localEndpoint: string, timeoutMs = 15_000): Promise<void> {
  const base = localEndpoint.replace(/\/$/, "");
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
      if (r.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitForVerifiedTunnel timeout");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("relay restart reconnect (no re-pair)", () => {
  it("persists attach credentials without nonce/invite/bearer material", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-relay-route-"));
    const routeFile = relayRouteFileFromStateFile(join(dir, "state.json"));
    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const echo = await listenEcho();

    const bridge = new RelayBridge({ routeFilePath: routeFile });
    const sessionCode = "PM-RSTR01";
    const inviteSecret = "inv_restart_test_secret_value_abcdef";

    await bridge.startCreator({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: echo.url
    });

    const saved = await loadRelayRoute(routeFile);
    expect(saved?.sessionCode).toBe(sessionCode);
    expect(saved?.role).toBe("creator");
    expect(saved?.relaySessionId.startsWith("rly_")).toBe(true);
    expect(saved?.relayAccessToken.startsWith("rat_")).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(inviteSecret);
    expect(JSON.stringify(saved)).not.toMatch(/nonce|sequence|sendSequence|privateKey/i);

    if (process.platform !== "win32") {
      const mode = (await stat(routeFile)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    await bridge.stop({ clearPersisted: true });
    expect(await loadRelayRoute(routeFile)).toBeNull();
    await echo.close();
    await relay.close();
  });

  it("restores relay route with fresh E2E after stop without invite re-use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-relay-restore-"));
    const creatorRoute = relayRouteFileFromStateFile(join(dir, "creator", "state.json"));
    const joinerRoute = relayRouteFileFromStateFile(join(dir, "joiner", "state.json"));

    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();

    const sessionCode = "PM-RSTR02";
    const inviteSecret = "inv_restore_pair_secret_value_12345678";

    const creatorBridge = new RelayBridge({ routeFilePath: creatorRoute });
    const joinerBridge = new RelayBridge({ routeFilePath: joinerRoute });

    await creatorBridge.startCreator({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: creatorEcho.url
    });

    const joinerStarted = joinerBridge.startJoiner({
      relayWsUrl,
      sessionCode,
      inviteSecret,
      localA2aBaseUrl: joinerEcho.url
    });
    await creatorBridge.awaitCreatorReady(30_000);
    await joinerStarted;

    const creatorEndpointBefore = creatorBridge.getLocalEndpoint();
    expect(creatorEndpointBefore).toBeTruthy();

    await waitForVerifiedTunnel(creatorEndpointBefore!);
    const pre = await fetch(`${creatorEndpointBefore}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: QUESTION })
    });
    expect(pre.status).toBe(200);
    expect(((await pre.json()) as { summary: string }).summary).toBe(ANSWER);

    // Simulate runtime restart: drop in-memory bridge, keep persisted route + Stage 8 session.
    await creatorBridge.stop({ clearPersisted: false });
    await joinerBridge.stop({ clearPersisted: false });

    const creatorRouteSaved = await loadRelayRoute(creatorRoute);
    const joinerRouteSaved = await loadRelayRoute(joinerRoute);
    expect(creatorRouteSaved).toBeTruthy();
    expect(joinerRouteSaved).toBeTruthy();

    const restoreCreator = creatorBridge.restoreIfNeeded({
      sessionCode,
      localA2aBaseUrl: creatorEcho.url,
      relayWsUrl
    });
    const restoreJoiner = joinerBridge.restoreIfNeeded({
      sessionCode,
      localA2aBaseUrl: joinerEcho.url,
      relayWsUrl
    });
    await Promise.all([restoreCreator, restoreJoiner]);
    await Promise.all([
      creatorBridge.awaitRestoredReady(30_000),
      joinerBridge.awaitRestoredReady(30_000)
    ]);

    expect(creatorBridge.getStatus().restored).toBe(true);
    expect(joinerBridge.getStatus().connected).toBe(true);

    const creatorEndpointAfter = creatorBridge.getLocalEndpoint();
    expect(creatorEndpointAfter).toBeTruthy();
    // Fresh egress listen — may differ from pre-restart port.
    expect(creatorEndpointAfter).not.toBe(creatorEndpointBefore);

    await waitForVerifiedTunnel(creatorEndpointAfter!);
    const post = await fetch(`${creatorEndpointAfter}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: QUESTION })
    });
    expect(post.status).toBe(200);
    expect(((await post.json()) as { summary: string }).summary).toBe(ANSWER);

    // Restore must not require invite secret (only persisted rat_).
    const raw = await readFile(creatorRoute, "utf8");
    expect(raw).not.toContain(inviteSecret);

    await creatorBridge.stop({ clearPersisted: true });
    await joinerBridge.stop({ clearPersisted: true });
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
    await clearRelayRoute(creatorRoute);
    await clearRelayRoute(joinerRoute);
  });

  it("persisted relay access token is distinct from invite secret", () => {
    const relaySessionId = createRelaySessionId(randomBytes);
    const inviteSecret = "inv_token_required_secret_value_zzzz";
    const token = deriveRelayAccessToken({
      inviteSecret,
      sessionCode: "PM-RSTR03",
      relaySessionId
    });
    expect(token.startsWith("rat_")).toBe(true);
    expect(token).not.toContain(inviteSecret);
    expect(token).not.toBe(inviteSecret);
  });

  it("fresh E2E after restore does not reuse prior send sequences with new keys", async () => {
    const relay = new HostedPairMeshRelay();
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorA2a = await listenEcho();
    const joinerA2a = await listenEcho();
    const sessionCode = "PM-RSTR04";
    const invite = "inv_fresh_e2e_secret_value_yyyyyyyy";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode,
      inviteSecret: invite,
      localA2aBaseUrl: creatorA2a.url
    });
    const joinerPromise = startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode,
      inviteSecret: invite,
      localA2aBaseUrl: joinerA2a.url
    });
    await creator.ready;
    const joiner = await joinerPromise;

    const credsCreator = {
      relayWsUrl: creator.path.relayWsUrl,
      relaySessionId: creator.path.relaySessionId,
      relayAccessToken: creator.path.relayAccessToken,
      sessionCode,
      role: "creator" as const,
      localA2aBaseUrl: creatorA2a.url
    };
    const credsJoiner = {
      relayWsUrl: joiner.path.relayWsUrl,
      relaySessionId: joiner.path.relaySessionId,
      relayAccessToken: joiner.path.relayAccessToken,
      sessionCode,
      role: "joiner" as const,
      localA2aBaseUrl: joinerA2a.url
    };

    await creator.path.stop();
    await joiner.path.stop();

    const restoredCreator = restoreRelayPath(credsCreator);
    const restoredJoiner = restoreRelayPath(credsJoiner);
    const [c2, j2] = await Promise.all([restoredCreator, restoredJoiner]);
    await Promise.all([c2.ready, j2.ready]);

    // New keypairs on restore — public keys must differ from the first handshake.
    expect(Buffer.from(c2.keyPair.publicKey).toString("hex")).not.toBe(
      Buffer.from(creator.keyPair.publicKey).toString("hex")
    );
    expect(Buffer.from(j2.keyPair.publicKey).toString("hex")).not.toBe(
      Buffer.from(joiner.keyPair.publicKey).toString("hex")
    );

    await waitForVerifiedTunnel(c2.path.localEndpoint);
    const res = await fetch(`${c2.path.localEndpoint}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: QUESTION })
    });
    expect(res.status).toBe(200);

    await c2.path.stop();
    await j2.path.stop();
    await creatorA2a.close();
    await joinerA2a.close();
    await relay.close();
  });
});
