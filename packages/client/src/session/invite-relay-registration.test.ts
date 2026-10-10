import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRelaySessionId,
  deriveRelayAccessToken,
  HostedPairMeshRelay,
  lookupRemoteRendezvous,
  PairMeshRelayClient,
  relayWsUrlToHttpBase
} from "../connectivity/index.js";
import { relayRouteFileFromStateFile } from "../connectivity/relay-route-store.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "./manager.js";

describe("invite relay access token registration", () => {
  it("registers additional invite tokens using persisted relay-route.json without runtime bridge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-invite-relay-"));
    const stateFilePath = join(dir, "state.json");
    const store = new LocalStateStore({ stateFilePath });
    const manager = new SessionManager({ stateStore: store });

    const relay = new HostedPairMeshRelay({ publicWsUrl: "wss://relay.test/relay" });
    const bound = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${bound.port}/relay`;
    const relayHttpBaseUrl = relayWsUrlToHttpBase(relayWsUrl);

    try {
      const created = await manager.createSession({
        name: "paul",
        agentUrl: "http://127.0.0.1:47201"
      });
      const creatorInvite = created.invite.inviteSecret;
      const relaySessionId = createRelaySessionId(randomBytes);
      const creatorToken = deriveRelayAccessToken({
        inviteSecret: creatorInvite,
        sessionCode: created.sessionCode,
        relaySessionId
      });

      relay.createSession({ accessToken: creatorToken, relaySessionId });
      relay.registerRendezvous({
        sessionCode: created.sessionCode,
        relaySessionId,
        creatorTransportPublicKey: "ab".repeat(32)
      });

      await writeFile(
        relayRouteFileFromStateFile(stateFilePath),
        JSON.stringify({
          version: 1,
          sessionCode: created.sessionCode,
          role: "creator",
          relayWsUrl,
          relaySessionId,
          relayAccessToken: creatorToken
        }),
        "utf8"
      );

      const kelvinInvite = await manager.createSessionInvite();
      const kelvinToken = deriveRelayAccessToken({
        inviteSecret: kelvinInvite.inviteSecret,
        sessionCode: created.sessionCode,
        relaySessionId
      });

      const client = new PairMeshRelayClient({
        relayUrl: relayWsUrl,
        relaySessionId,
        relayAccessToken: kelvinToken
      });
      await client.connect();
      await client.close();

      const rendezvous = await lookupRemoteRendezvous({
        relayHttpBaseUrl: relayHttpBaseUrl,
        sessionCode: created.sessionCode
      });
      expect(rendezvous?.relaySessionId).toBe(relaySessionId);
    } finally {
      await relay.close();
    }
  });
});
