import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HostedPairMeshRelay,
  startCreatorRelayPath,
  startJoinerRelayPath,
  restoreRelayPath
} from "./index.js";

async function listenEcho(): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", ok: true }));
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 40
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function healthOk(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe("sticky creator↔joiner presence (Stage 18 Prompt 7)", () => {
  it("P1+P5: destination_unavailable(presence) retargets; egress URL stays alive", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    const endpoints: { id: string; url: string }[] = [];

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-STICK1",
      inviteSecret: "inv_sticky_presence_p1_secret_aaaa",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        endpoints.push({ id: ev.relayParticipantId, url: ev.localEndpoint });
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-STICK1",
      inviteSecret: "inv_sticky_presence_p1_secret_aaaa",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => endpoints.length >= 1);

    const presenceId = joiner.path.relayPresenceId!;
    const façade = endpoints.find((e) => e.id === presenceId)?.url;
    expect(façade).toBeTruthy();
    expect(await healthOk(façade!)).toBe(true);

    const beforeDest = creator.path.getCreatorSendDestForTest?.(presenceId);
    expect(beforeDest?.toConnectionId).toBe(joiner.path.client.id);
    expect(beforeDest?.toParticipantId).toBe(presenceId);

    const endpointCountBefore = endpoints.length;
    creator.path.client.injectWireErrorForTest({
      message: "destination_unavailable",
      toParticipantId: presenceId
    });

    // Egress must remain (no prune-close); sendDest still prefers live connectionId.
    await new Promise((r) => setTimeout(r, 50));
    expect(endpoints.length).toBe(endpointCountBefore);
    expect(await healthOk(façade!)).toBe(true);
    const afterDest = creator.path.getCreatorSendDestForTest?.(presenceId);
    expect(afterDest?.toConnectionId).toBe(joiner.path.client.id);
    expect(afterDest?.toParticipantId).toBe(presenceId);

    // Joiner → creator still valid (asymmetric direction must remain repairable).
    expect(await healthOk(joiner.path.localEndpoint)).toBe(true);

    await creator.path.stop();
    await joiner.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("P2: destination_unavailable(connectionId) fully prunes egress", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    let façade = "";

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-STICK2",
      inviteSecret: "inv_sticky_presence_p2_secret_bbbb",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        façade = ev.localEndpoint;
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-STICK2",
      inviteSecret: "inv_sticky_presence_p2_secret_bbbb",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façade.length > 0);
    expect(await healthOk(façade)).toBe(true);

    const connId = joiner.path.client.id;
    const presenceId = joiner.path.relayPresenceId!;
    creator.path.client.injectWireErrorForTest({
      message: "destination_unavailable",
      toConnectionId: connId
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(creator.path.getCreatorSendDestForTest?.(presenceId)).toBeUndefined();
    expect(await healthOk(façade, 800)).toBe(false);

    await creator.path.stop();
    await joiner.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 60_000);

  it("P3+P4: restore same presence with new connectionId; creator repairs outbound", async () => {
    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60 * 60_000 });
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const creatorEcho = await listenEcho();
    const joinerEcho = await listenEcho();
    const façades: string[] = [];

    const creator = await startCreatorRelayPath({
      relayWsUrl,
      sessionCode: "PM-STICK3",
      inviteSecret: "inv_sticky_presence_p3_secret_cccc",
      localA2aBaseUrl: creatorEcho.url,
      onPeerEndpoint: (ev) => {
        façades.push(ev.localEndpoint);
      }
    });
    const joiner = await startJoinerRelayPath({
      relayWsUrlHint: relayWsUrl,
      sessionCode: "PM-STICK3",
      inviteSecret: "inv_sticky_presence_p3_secret_cccc",
      localA2aBaseUrl: joinerEcho.url
    });
    await creator.ready;
    await waitFor(() => façades.length >= 1);

    const presenceId = joiner.path.relayPresenceId!;
    const gen = joiner.path.presenceGeneration ?? 1;
    const oldConn = joiner.path.client.id;
    expect(creator.path.getCreatorSendDestForTest?.(presenceId)?.toConnectionId).toBe(oldConn);

    // Joiner → creator works before restore.
    expect(await healthOk(joiner.path.localEndpoint)).toBe(true);

    await joiner.path.stop();
    const joiner2 = await restoreRelayPath({
      relayWsUrl: joiner.path.relayWsUrl,
      relaySessionId: joiner.path.relaySessionId,
      relayAccessToken: joiner.path.relayAccessToken,
      sessionCode: "PM-STICK3",
      role: "joiner",
      localA2aBaseUrl: joinerEcho.url,
      relayPresenceId: presenceId,
      presenceGeneration: gen
    });
    await joiner2.ready;

    expect(joiner2.path.relayPresenceId).toBe(presenceId);
    expect((joiner2.path.presenceGeneration ?? 0) > gen).toBe(true);
    const newConn = joiner2.path.client.id;
    expect(newConn).not.toBe(oldConn);

    await waitFor(
      () => creator.path.getCreatorSendDestForTest?.(presenceId)?.toConnectionId === newConn,
      15_000
    );

    const latestFaçade = façades[façades.length - 1]!;
    expect(await healthOk(latestFaçade)).toBe(true);
    expect(await healthOk(joiner2.path.localEndpoint)).toBe(true);

    // Stale presence-route error must not kill repaired egress when new conn is known.
    creator.path.client.injectWireErrorForTest({
      message: "destination_unavailable",
      toParticipantId: presenceId
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await healthOk(latestFaçade)).toBe(true);
    expect(creator.path.getCreatorSendDestForTest?.(presenceId)?.toConnectionId).toBe(newConn);

    await creator.path.stop();
    await joiner2.path.stop();
    await creatorEcho.close();
    await joinerEcho.close();
    await relay.close();
  }, 90_000);
});
