import { describe, expect, it } from "vitest";
import {
  createRelayAccessToken,
  deriveDirectionalKeys,
  deriveRelayChannelId,
  E2ETransportSession,
  encodePublicKey,
  generateTransportKeyPair,
  MockPairMeshRelay,
  PairMeshRelayClient,
  RelayChannelManager
} from "./index.js";
import { randomBytes } from "node:crypto";

const PAUL = "participant_paul_aaaaaaaa";
const KELVIN = "participant_kelvin_bbbbbbbb";
const SARAH = "participant_sarah_cccccccc";
const SESSION = "ses_multi_peer_14";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Stage 14 multi-peer relay / channels", () => {
  it("attaches three clients with distinct tokens on one session", async () => {
    const relay = new MockPairMeshRelay();
    const { url } = await relay.listen();
    const tokenPaul = createRelayAccessToken(randomBytes);
    const tokenKelvin = createRelayAccessToken(randomBytes);
    const tokenSarah = createRelayAccessToken(randomBytes);
    const session = relay.createSession({ accessToken: tokenPaul });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenKelvin
    });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenSarah
    });

    const paul = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenPaul,
      fromParticipantId: PAUL
    });
    const kelvin = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenKelvin,
      fromParticipantId: KELVIN
    });
    const sarah = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenSarah,
      fromParticipantId: SARAH
    });

    await paul.connect();
    await kelvin.connect();
    await sarah.connect();
    expect(paul.isAttached).toBe(true);
    expect(kelvin.isAttached).toBe(true);
    expect(sarah.isAttached).toBe(true);

    await paul.close();
    await kelvin.close();
    await sarah.close();
    await relay.close();
  });

  it("unicasts Paul→Kelvin so Sarah receives zero forwards", async () => {
    const relay = new MockPairMeshRelay();
    const { url } = await relay.listen();
    const tokenPaul = createRelayAccessToken(randomBytes);
    const tokenKelvin = createRelayAccessToken(randomBytes);
    const tokenSarah = createRelayAccessToken(randomBytes);
    const session = relay.createSession({ accessToken: tokenPaul });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenKelvin
    });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenSarah
    });

    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();
    const channelId = deriveRelayChannelId({
      relaySessionId: session.relaySessionId,
      localParticipantId: PAUL,
      remoteParticipantId: KELVIN
    });

    const paul = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenPaul,
      fromParticipantId: PAUL
    });
    const kelvin = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenKelvin,
      fromParticipantId: KELVIN
    });
    const sarah = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenSarah,
      fromParticipantId: SARAH
    });

    const paulMgr = new RelayChannelManager(paul, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });
    const kelvinMgr = new RelayChannelManager(kelvin, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });
    paulMgr.openChannel({
      remoteParticipantId: KELVIN,
      remotePublicKey: kelvinKp.publicKey,
      localParticipantId: PAUL,
      localPrivateKey: paulKp.privateKey
    });
    kelvinMgr.openChannel({
      remoteParticipantId: PAUL,
      remotePublicKey: paulKp.publicKey,
      localParticipantId: KELVIN,
      localPrivateKey: kelvinKp.privateKey
    });

    let kelvinGot = false;
    let sarahPlain = 0;
    kelvin.onPlaintext((p) => {
      if (new TextDecoder().decode(p) === "pk-secret") kelvinGot = true;
    });
    sarah.onPlaintext(() => {
      sarahPlain += 1;
    });

    await paul.connect();
    await kelvin.connect();
    await sarah.connect();
    await sleep(20);

    await paul.sendPlaintext(new TextEncoder().encode("pk-secret"), {
      toParticipantId: KELVIN,
      channelId,
      fromParticipantId: PAUL
    });
    await sleep(60);

    expect(kelvinGot).toBe(true);
    expect(sarahPlain).toBe(0);

    // Sarah cannot decrypt P↔K ciphertext even with the bytes (cross-key).
    const pkFrame = paulMgr.getChannel(channelId)!.e2e.encrypt(new TextEncoder().encode("pk-only"));
    const sarahWrong = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: generateTransportKeyPair().privateKey,
        peerPublicKey: paulKp.publicKey,
        sessionId: SESSION,
        localParticipantId: SARAH,
        peerParticipantId: PAUL,
        channelId
      })
    );
    expect(() =>
      sarahWrong.decrypt({
        version: 1,
        sequence: pkFrame.sequence,
        ciphertext: pkFrame.ciphertext
      })
    ).toThrow(/decrypt|Transport decryption/i);

    await paul.close();
    await kelvin.close();
    await sarah.close();
    await relay.close();
  });

  it("binds distinct channel keys so cross-channel decrypt fails", () => {
    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();
    const sarahKp = generateTransportKeyPair();
    const rly = "rly_" + "ab".repeat(16);
    const chPk = deriveRelayChannelId({
      relaySessionId: rly,
      localParticipantId: PAUL,
      remoteParticipantId: KELVIN
    });
    const chPs = deriveRelayChannelId({
      relaySessionId: rly,
      localParticipantId: PAUL,
      remoteParticipantId: SARAH
    });
    expect(chPk).not.toBe(chPs);

    const paulToKelvin = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: paulKp.privateKey,
        peerPublicKey: kelvinKp.publicKey,
        sessionId: SESSION,
        localParticipantId: PAUL,
        peerParticipantId: KELVIN,
        channelId: chPk
      })
    );
    const kelvinFromPaul = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: kelvinKp.privateKey,
        peerPublicKey: paulKp.publicKey,
        sessionId: SESSION,
        localParticipantId: KELVIN,
        peerParticipantId: PAUL,
        channelId: chPk
      })
    );
    const sarahOnWrongChannel = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: sarahKp.privateKey,
        peerPublicKey: paulKp.publicKey,
        sessionId: SESSION,
        localParticipantId: SARAH,
        peerParticipantId: PAUL,
        channelId: chPs
      })
    );

    const frame = paulToKelvin.encrypt(new TextEncoder().encode("channel-bound"));
    expect(new TextDecoder().decode(kelvinFromPaul.decrypt(frame))).toBe("channel-bound");
    expect(() => sarahOnWrongChannel.decrypt(frame)).toThrow(/decrypt|Transport decryption/i);

    // Same peer keys but wrong channelId in HKDF still fails.
    const kelvinWrongChannel = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: kelvinKp.privateKey,
        peerPublicKey: paulKp.publicKey,
        sessionId: SESSION,
        localParticipantId: KELVIN,
        peerParticipantId: PAUL,
        channelId: chPs
      })
    );
    expect(() => kelvinWrongChannel.decrypt(frame)).toThrow(/decrypt|Transport decryption/i);
  });

  it("opens pair-later K↔S channel without breaking P↔K", async () => {
    const relay = new MockPairMeshRelay();
    const { url } = await relay.listen();
    const tokenPaul = createRelayAccessToken(randomBytes);
    const tokenKelvin = createRelayAccessToken(randomBytes);
    const tokenSarah = createRelayAccessToken(randomBytes);
    const session = relay.createSession({ accessToken: tokenPaul });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenKelvin
    });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenSarah
    });

    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();
    const sarahKp = generateTransportKeyPair();

    const paul = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenPaul,
      fromParticipantId: PAUL
    });
    const kelvin = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenKelvin,
      fromParticipantId: KELVIN
    });
    const sarah = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenSarah,
      fromParticipantId: SARAH
    });

    const paulMgr = new RelayChannelManager(paul, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });
    const kelvinMgr = new RelayChannelManager(kelvin, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });
    const sarahMgr = new RelayChannelManager(sarah, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });

    const chPk = paulMgr.openChannel({
      remoteParticipantId: KELVIN,
      remotePublicKey: kelvinKp.publicKey,
      localParticipantId: PAUL,
      localPrivateKey: paulKp.privateKey
    }).channelId;
    kelvinMgr.openChannel({
      remoteParticipantId: PAUL,
      remotePublicKey: paulKp.publicKey,
      localParticipantId: KELVIN,
      localPrivateKey: kelvinKp.privateKey
    });

    await paul.connect();
    await kelvin.connect();
    await sarah.connect();

    let pkOk = false;
    kelvin.onPlaintext((p, meta) => {
      if (meta.channelId === chPk && new TextDecoder().decode(p) === "still-pk") pkOk = true;
    });
    await paul.sendPlaintext(new TextEncoder().encode("still-pk"), {
      toParticipantId: KELVIN,
      channelId: chPk
    });
    await sleep(50);
    expect(pkOk).toBe(true);

    // Pair-later: Kelvin ↔ Sarah
    const chKs = kelvinMgr.openChannel({
      remoteParticipantId: SARAH,
      remotePublicKey: sarahKp.publicKey,
      localParticipantId: KELVIN,
      localPrivateKey: kelvinKp.privateKey
    }).channelId;
    sarahMgr.openChannel({
      remoteParticipantId: KELVIN,
      remotePublicKey: kelvinKp.publicKey,
      localParticipantId: SARAH,
      localPrivateKey: sarahKp.privateKey
    });
    expect(chKs).not.toBe(chPk);

    let ksOk = false;
    sarah.onPlaintext((p, meta) => {
      if (meta.channelId === chKs && new TextDecoder().decode(p) === "ks-hello") ksOk = true;
    });
    await kelvin.sendPlaintext(new TextEncoder().encode("ks-hello"), {
      toParticipantId: SARAH,
      channelId: chKs
    });
    await sleep(50);
    expect(ksOk).toBe(true);

    // P↔K still works after K↔S opened
    pkOk = false;
    await paul.sendPlaintext(new TextEncoder().encode("still-pk"), {
      toParticipantId: KELVIN,
      channelId: chPk
    });
    await sleep(50);
    expect(pkOk).toBe(true);

    await paul.close();
    await kelvin.close();
    await sarah.close();
    await relay.close();
  });

  it("closes one channel while leaving others open", async () => {
    const relay = new MockPairMeshRelay();
    const { url } = await relay.listen();
    const tokenPaul = createRelayAccessToken(randomBytes);
    const tokenKelvin = createRelayAccessToken(randomBytes);
    const tokenSarah = createRelayAccessToken(randomBytes);
    const session = relay.createSession({ accessToken: tokenPaul });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenKelvin
    });
    relay.addAccessToken({
      relaySessionId: session.relaySessionId,
      authorizingToken: tokenPaul,
      newToken: tokenSarah
    });

    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();
    const sarahKp = generateTransportKeyPair();

    const paul = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenPaul,
      fromParticipantId: PAUL
    });
    const kelvin = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenKelvin,
      fromParticipantId: KELVIN
    });
    const sarah = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: tokenSarah,
      fromParticipantId: SARAH
    });

    const paulMgr = new RelayChannelManager(paul, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });
    const kelvinMgr = new RelayChannelManager(kelvin, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });
    const sarahMgr = new RelayChannelManager(sarah, {
      relaySessionId: session.relaySessionId,
      sessionId: SESSION
    });

    const chPk = paulMgr.openChannel({
      remoteParticipantId: KELVIN,
      remotePublicKey: encodePublicKey(kelvinKp.publicKey),
      localParticipantId: PAUL,
      localPrivateKey: paulKp.privateKey
    }).channelId;
    kelvinMgr.openChannel({
      remoteParticipantId: PAUL,
      remotePublicKey: paulKp.publicKey,
      localParticipantId: KELVIN,
      localPrivateKey: kelvinKp.privateKey
    });
    const chPs = paulMgr.openChannel({
      remoteParticipantId: SARAH,
      remotePublicKey: sarahKp.publicKey,
      localParticipantId: PAUL,
      localPrivateKey: paulKp.privateKey
    }).channelId;
    sarahMgr.openChannel({
      remoteParticipantId: PAUL,
      remotePublicKey: paulKp.publicKey,
      localParticipantId: SARAH,
      localPrivateKey: sarahKp.privateKey
    });

    await paul.connect();
    await kelvin.connect();
    await sarah.connect();

    paulMgr.closeChannel(chPk);
    expect(paulMgr.status(chPk)).toBeUndefined();
    expect(paulMgr.getChannel(chPs)?.status).toBe("open");

    let sarahGot = false;
    sarah.onPlaintext((p) => {
      if (new TextDecoder().decode(p) === "ps-alive") sarahGot = true;
    });
    await paul.sendPlaintext(new TextEncoder().encode("ps-alive"), {
      toParticipantId: SARAH,
      channelId: chPs
    });
    await sleep(50);
    expect(sarahGot).toBe(true);

    // Closed P↔K channel no longer decrypts on Paul's client.
    let kelvinPlain = false;
    kelvin.onPlaintext(() => {
      kelvinPlain = true;
    });
    await expect(
      paul.sendPlaintext(new TextEncoder().encode("should-fail"), {
        toParticipantId: KELVIN,
        channelId: chPk
      })
    ).rejects.toThrow(/E2E transport session not established/i);
    expect(kelvinPlain).toBe(false);

    await paul.close();
    await kelvin.close();
    await sarah.close();
    await relay.close();
  });

  it("Stage 13 two-party still works without toConnectionId (implicit unicast)", async () => {
    const relay = new MockPairMeshRelay();
    const { url } = await relay.listen();
    const session = relay.createSession();
    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();

    const paul = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: new E2ETransportSession(
        deriveDirectionalKeys({
          localPrivateKey: paulKp.privateKey,
          peerPublicKey: kelvinKp.publicKey,
          sessionId: "ses_13",
          localParticipantId: "paul",
          peerParticipantId: "kelvin"
        })
      )
    });
    const kelvin = new PairMeshRelayClient({
      relayUrl: url,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: new E2ETransportSession(
        deriveDirectionalKeys({
          localPrivateKey: kelvinKp.privateKey,
          peerPublicKey: paulKp.publicKey,
          sessionId: "ses_13",
          localParticipantId: "kelvin",
          peerParticipantId: "paul"
        })
      )
    });

    let got = false;
    kelvin.onPlaintext((p) => {
      if (new TextDecoder().decode(p) === "legacy-2p") got = true;
    });
    await kelvin.connect();
    await paul.connect();
    await paul.sendPlaintext(new TextEncoder().encode("legacy-2p"));
    await sleep(50);
    expect(got).toBe(true);

    await paul.close();
    await kelvin.close();
    await relay.close();
  });
});
