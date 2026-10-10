import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { deriveRelayAccessToken } from "./relay/access-token.js";
import { HostedPairMeshRelay } from "./relay/hosted-server.js";
import {
  restoreRelayPath,
  startCreatorRelayPath,
  startJoinerRelayPath,
  type RelayPeerEndpointEvent
} from "./relay-bootstrap.js";

const ANSWER = "ANSWER_CANARY_multi_peer_chaos";

async function listenEcho(): Promise<{
  url: string;
  close: () => Promise<void>;
  server: Server;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ summary: ANSWER }));
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

async function askThroughTunnel(localEndpoint: string): Promise<string> {
  const base = localEndpoint.replace(/\/$/, "");
  const started = Date.now();
  for (;;) {
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
      if (health.ok) break;
    } catch {
      /* verifying */
    }
    if (Date.now() - started > 15_000) throw new Error("askThroughTunnel: route not verified");
    await sleep(25);
  }
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "ping" })
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { summary: string }).summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Vitest subset — full creator/joiner partial-restart chaos runs via
 * `pnpm exec tsx scripts/stage14-relay-chaos.mts` (Vitest worker WS timing differs).
 */
describe("relay multi-peer chaos (Stage 14 Prompt 5)", () => {
  it("relay bounce — all three peers re-attach and recover", async () => {
    const kelvinEcho = await listenEcho();
    const sarahEcho = await listenEcho();
    let relay = new HostedPairMeshRelay();
    let bound = await relay.listen("127.0.0.1", 0);
    let relayWsUrl = `ws://127.0.0.1:${bound.port}/relay`;
    const sessionCode = "PM-CHAOS3";
    const inviteKelvin = "invite_secret_kelvin_chaos3_123456";
    const inviteSarah = "invite_secret_sarah_chaos3_1234567";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode,
      inviteSecret: inviteKelvin,
      localA2aBaseUrl: kelvinEcho.url
    });

    const kelvin = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode,
      inviteSecret: inviteKelvin,
      localA2aBaseUrl: kelvinEcho.url
    });

    const tokenSarah = deriveRelayAccessToken({
      inviteSecret: inviteSarah,
      sessionCode,
      relaySessionId: creator.path.relaySessionId
    });
    relay.addAccessToken({
      relaySessionId: creator.path.relaySessionId,
      authorizingToken: creator.path.relayAccessToken,
      newToken: tokenSarah
    });

    const sarah = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode,
      inviteSecret: inviteSarah,
      localA2aBaseUrl: sarahEcho.url
    });

    const previousRelaySessionId = creator.path.relaySessionId;
    const credsCreator = {
      relayWsUrl,
      relaySessionId: previousRelaySessionId,
      relayAccessToken: creator.path.relayAccessToken,
      sessionCode,
      role: "creator" as const,
      localA2aBaseUrl: kelvinEcho.url
    };
    const credsKelvin = {
      relayWsUrl: kelvin.path.relayWsUrl,
      relaySessionId: kelvin.path.relaySessionId,
      relayAccessToken: kelvin.path.relayAccessToken,
      sessionCode,
      role: "joiner" as const,
      localA2aBaseUrl: kelvinEcho.url
    };
    const credsSarah = {
      relayWsUrl: sarah.path.relayWsUrl,
      relaySessionId: sarah.path.relaySessionId,
      relayAccessToken: sarah.path.relayAccessToken,
      sessionCode,
      role: "joiner" as const,
      localA2aBaseUrl: sarahEcho.url
    };

    await creator.path.stop();
    await kelvin.path.stop();
    await sarah.path.stop();
    await relay.close();

    relay = new HostedPairMeshRelay();
    bound = await relay.listen("127.0.0.1", 0);
    relayWsUrl = `ws://127.0.0.1:${bound.port}/relay`;
    relay.createSession({
      accessToken: credsCreator.relayAccessToken,
      relaySessionId: previousRelaySessionId
    });
    relay.addAccessToken({
      relaySessionId: previousRelaySessionId,
      authorizingToken: credsCreator.relayAccessToken,
      newToken: credsKelvin.relayAccessToken
    });
    relay.addAccessToken({
      relaySessionId: previousRelaySessionId,
      authorizingToken: credsCreator.relayAccessToken,
      newToken: credsSarah.relayAccessToken
    });

    const rebound: RelayPeerEndpointEvent[] = [];
    const [c2, k2, s2] = await Promise.all([
      restoreRelayPath(
        { ...credsCreator, relayWsUrl },
        {
          onPeerEndpoint: async (event) => {
            rebound.push(event);
          }
        }
      ),
      restoreRelayPath({ ...credsKelvin, relayWsUrl }),
      restoreRelayPath({ ...credsSarah, relayWsUrl })
    ]);
    await Promise.all([c2.ready, k2.ready, s2.ready]);

    for (let i = 0; i < 15; i += 1) {
      if (rebound.length >= 2) break;
      await sleep(1000);
    }

    expect(rebound.length).toBeGreaterThanOrEqual(2);
    for (const endpoint of rebound) {
      expect(await askThroughTunnel(endpoint.localEndpoint)).toBe(ANSWER);
    }

    await c2.path.stop();
    await k2.path.stop();
    await s2.path.stop();
    await relay.close();
    await kelvinEcho.close();
    await sarahEcho.close();
  }, 30_000);
});
