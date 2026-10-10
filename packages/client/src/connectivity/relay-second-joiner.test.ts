import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  deriveRelayAccessToken,
  HostedPairMeshRelay,
  startCreatorRelayPath,
  startJoinerRelayPath
} from "./index.js";

describe("relay bootstrap second joiner", () => {
  it("allows a second joiner to complete handshake while first stays attached", async () => {
    const creatorAgent = createServer((req, res) => {
      if (req.url?.includes("agent-card")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "paul-agent", protocolVersion: "0.3.0" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => creatorAgent.listen(59001, "127.0.0.1", () => resolve()));

    const relay = new HostedPairMeshRelay({ publicWsUrl: "wss://relay.test/relay" });
    const bound = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${bound.port}/relay`;
    const sessionCode = "PM-SECOND1";
    const inviteA = "invite_secret_for_kelvin_123456";
    const inviteB = "invite_secret_for_sarah_123456789";

    try {
      const creator = await startCreatorRelayPath({
        relayWsUrl,
        sessionCode,
        inviteSecret: inviteA,
        localA2aBaseUrl: "http://127.0.0.1:59001"
      });

      const kelvin = await startJoinerRelayPath({
        relayWsUrlHint: relayWsUrl,
        sessionCode,
        inviteSecret: inviteA,
        localA2aBaseUrl: "http://127.0.0.1:59002"
      });

      const tokenB = deriveRelayAccessToken({
        inviteSecret: inviteB,
        sessionCode,
        relaySessionId: creator.path.relaySessionId
      });
      relay.addAccessToken({
        relaySessionId: creator.path.relaySessionId,
        authorizingToken: creator.path.relayAccessToken,
        newToken: tokenB
      });

      const sarah = await startJoinerRelayPath({
        relayWsUrlHint: relayWsUrl,
        sessionCode,
        inviteSecret: inviteB,
        localA2aBaseUrl: "http://127.0.0.1:59003"
      });

      expect(kelvin.path.connected).toBe(true);
      expect(sarah.path.connected).toBe(true);
      expect(kelvin.path.localEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(sarah.path.localEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);

      await creator.path.stop();
      await kelvin.path.stop();
      await sarah.path.stop();
    } finally {
      await relay.close();
      creatorAgent.close();
    }
  }, 60_000);
});
