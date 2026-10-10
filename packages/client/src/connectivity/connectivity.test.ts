import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  DefaultConnectivityResolver,
  deriveDirectionalKeys,
  E2ETransportSession,
  encodePublicKey,
  generateTransportKeyPair,
  LocalRelayRendezvous,
  MockPairMeshRelay,
  PairMeshRelayClient,
  RelayHttpEgress,
  RelayHttpIngress,
  createRelayAccessToken,
  createRelaySessionId
} from "./index.js";
import { randomBytes } from "node:crypto";

const QUESTION_CANARY = "QUESTION_CANARY_rebuildPaymentFromRetryRecord";
const BEARER_CANARY = "BEARER_CANARY_pmb_deadbeefdeadbeefdeadbeefdeadbeef";
const SOURCE_CANARY = "SOURCE_CANARY_src/retry.ts";
const ANSWER_CANARY = "ANSWER_CANARY_customerId_null";

async function listenJsonEcho(): Promise<{
  url: string;
  close: () => Promise<void>;
  server: Server;
}> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.includes("health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", readyForInspection: true }));
        return;
      }
      // Simulate A2A inspect response containing canaries only in plaintext here (local).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          echo: body,
          summary: ANSWER_CANARY,
          references: [{ file: SOURCE_CANARY, startLine: 8, endLine: 13 }],
          authHeader: req.headers.authorization ?? null
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

describe("connectivity resolver", () => {
  it("resolves direct-url and overlay modes", async () => {
    const resolver = new DefaultConnectivityResolver();
    const direct = await resolver.resolvePeer({
      mode: "direct-url",
      a2aAgentUrl: "http://100.1.2.3:47100"
    });
    expect(direct.mode).toBe("direct-url");
    expect(direct.transportEndpoint).toBe("http://100.1.2.3:47100");

    const overlay = await resolver.resolvePeer({
      mode: "overlay",
      a2aAgentUrl: "http://100.9.9.9:47100"
    });
    expect(overlay.mode).toBe("overlay");
  });

  it("resolves relay mode metadata without requiring peer URL", async () => {
    const resolver = new DefaultConnectivityResolver();
    const relaySessionId = createRelaySessionId(randomBytes);
    const relay = await resolver.resolvePeer({
      mode: "relay",
      relayUrl: "ws://127.0.0.1:9/relay",
      relaySessionId
    });
    expect(relay.mode).toBe("relay");
    if (relay.mode === "relay") {
      expect(relay.relaySessionId).toBe(relaySessionId);
    }
  });
});

describe("E2E transport session", () => {
  it("encrypts directionally and rejects replay/tamper", () => {
    const paul = generateTransportKeyPair();
    const kelvin = generateTransportKeyPair();
    const paulKeys = deriveDirectionalKeys({
      localPrivateKey: paul.privateKey,
      peerPublicKey: kelvin.publicKey,
      sessionId: "ses_test",
      localParticipantId: "peer_paul",
      peerParticipantId: "peer_kelvin"
    });
    const kelvinKeys = deriveDirectionalKeys({
      localPrivateKey: kelvin.privateKey,
      peerPublicKey: paul.publicKey,
      sessionId: "ses_test",
      localParticipantId: "peer_kelvin",
      peerParticipantId: "peer_paul"
    });
    const paulTx = new E2ETransportSession(paulKeys);
    const kelvinTx = new E2ETransportSession(kelvinKeys);

    const frame = paulTx.encrypt(new TextEncoder().encode(QUESTION_CANARY));
    const plain = kelvinTx.decrypt(frame);
    expect(new TextDecoder().decode(plain)).toBe(QUESTION_CANARY);

    expect(() => kelvinTx.decrypt(frame)).toThrow(/Duplicate|replay|transport_replay/i);

    const tampered = {
      ...frame,
      ciphertext: (() => {
        const copy = new Uint8Array(frame.ciphertext);
        copy[0] ^= 0xff;
        return copy;
      })()
    };
    const kelvinTx2 = new E2ETransportSession(kelvinKeys);
    // Fresh session with same keys but reset counters — decrypt tampered should fail auth tag
    expect(() => kelvinTx2.decrypt({ ...tampered, sequence: 0 })).toThrow(/decrypt/i);
  });

  it("does not treat invite secret as transport key material", () => {
    const a = generateTransportKeyPair();
    const b = generateTransportKeyPair();
    const keys = deriveDirectionalKeys({
      localPrivateKey: a.privateKey,
      peerPublicKey: b.publicKey,
      sessionId: "ses_x",
      localParticipantId: "p1",
      peerParticipantId: "p2"
    });
    // Sanity: public keys encode as hex; invite-looking strings are unrelated.
    expect(encodePublicKey(a.publicKey)).not.toContain("invite");
    expect(keys.sendKey.length).toBe(32);
  });
});

describe("mock relay + HTTP tunnel", () => {
  it("routes ciphertext, hides canaries from relay, and preserves A2A-shaped JSON", async () => {
    const relay = new MockPairMeshRelay();
    const { url: relayUrl } = await relay.listen();
    const echo = await listenJsonEcho();
    const session = relay.createSession();

    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();
    const paulE2e = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: paulKp.privateKey,
        peerPublicKey: kelvinKp.publicKey,
        sessionId: "ses_relay",
        localParticipantId: "peer_paul",
        peerParticipantId: "peer_kelvin"
      })
    );
    const kelvinE2e = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: kelvinKp.privateKey,
        peerPublicKey: paulKp.publicKey,
        sessionId: "ses_relay",
        localParticipantId: "peer_kelvin",
        peerParticipantId: "peer_paul"
      })
    );

    const paulClient = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: paulE2e
    });
    const kelvinClient = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: kelvinE2e
    });

    await kelvinClient.connect();
    const ingress = new RelayHttpIngress(kelvinClient, echo.url, "creator");
    const stopIngress = ingress.start();
    await paulClient.connect();
    const egress = new RelayHttpEgress(paulClient, "creator");
    const localEndpoint = await egress.listen();

    const response = await fetch(`${localEndpoint}/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER_CANARY}`
      },
      body: JSON.stringify({ question: QUESTION_CANARY })
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      summary: string;
      references: Array<{ file: string }>;
      authHeader: string | null;
      echo: string;
    };
    expect(json.summary).toBe(ANSWER_CANARY);
    expect(json.references[0]?.file).toBe(SOURCE_CANARY);
    expect(json.authHeader).toBe(`Bearer ${BEARER_CANARY}`);
    expect(json.echo).toContain(QUESTION_CANARY);

    const observed = relay.getObservedRawText();
    expect(observed).not.toContain(QUESTION_CANARY);
    expect(observed).not.toContain(BEARER_CANARY);
    expect(observed).not.toContain(SOURCE_CANARY);
    expect(observed).not.toContain(ANSWER_CANARY);
    expect(observed).toContain("ciphertextB64");

    // Credential separation
    expect(session.relayAccessToken.startsWith("rat_")).toBe(true);
    expect(session.relaySessionId.startsWith("rly_")).toBe(true);
    expect(session.relayAccessToken).not.toBe(BEARER_CANARY);

    stopIngress();
    await egress.close();
    await paulClient.close();
    await kelvinClient.close();
    await echo.close();
    await relay.close();
  });

  it("rejects third client without matching E2E keys (routing ≠ authorization)", async () => {
    const relay = new MockPairMeshRelay();
    const { url: relayUrl } = await relay.listen();
    const session = relay.createSession();

    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();
    const malloryKp = generateTransportKeyPair();

    const paulClient = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: new E2ETransportSession(
        deriveDirectionalKeys({
          localPrivateKey: paulKp.privateKey,
          peerPublicKey: kelvinKp.publicKey,
          sessionId: "ses_m",
          localParticipantId: "paul",
          peerParticipantId: "kelvin"
        })
      )
    });
    const kelvinClient = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: new E2ETransportSession(
        deriveDirectionalKeys({
          localPrivateKey: kelvinKp.privateKey,
          peerPublicKey: paulKp.publicKey,
          sessionId: "ses_m",
          localParticipantId: "kelvin",
          peerParticipantId: "paul"
        })
      )
    });
    const malloryClient = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: new E2ETransportSession(
        deriveDirectionalKeys({
          localPrivateKey: malloryKp.privateKey,
          peerPublicKey: paulKp.publicKey,
          sessionId: "ses_m",
          localParticipantId: "mallory",
          peerParticipantId: "paul"
        })
      )
    });

    let mallorySawPlain = false;
    await paulClient.connect();
    await kelvinClient.connect();
    await malloryClient.connect();
    malloryClient.onPlaintext(() => {
      mallorySawPlain = true;
    });

    let kelvinOk = false;
    kelvinClient.onPlaintext((p) => {
      if (new TextDecoder().decode(p) === "secret") kelvinOk = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    await paulClient.sendPlaintext(new TextEncoder().encode("secret"), {
      toConnectionId: kelvinClient.id
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(kelvinOk).toBe(true);
    expect(mallorySawPlain).toBe(false);

    await paulClient.close();
    await kelvinClient.close();
    await malloryClient.close();
    await relay.close();
  });

  it("rejects malicious relay ciphertext modification", async () => {
    const paul = generateTransportKeyPair();
    const kelvin = generateTransportKeyPair();
    const kelvinTx = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: kelvin.privateKey,
        peerPublicKey: paul.publicKey,
        sessionId: "ses_t",
        localParticipantId: "kelvin",
        peerParticipantId: "paul"
      })
    );
    const paulTx = new E2ETransportSession(
      deriveDirectionalKeys({
        localPrivateKey: paul.privateKey,
        peerPublicKey: kelvin.publicKey,
        sessionId: "ses_t",
        localParticipantId: "paul",
        peerParticipantId: "kelvin"
      })
    );
    const frame = paulTx.encrypt(new TextEncoder().encode("ok"));
    const modified = new Uint8Array(frame.ciphertext);
    modified[modified.length - 1] ^= 0x55;
    expect(() => kelvinTx.decrypt({ ...frame, ciphertext: modified })).toThrow(
      /decrypt|Transport decryption/i
    );
  });
});

describe("local rendezvous / SessionCode separation", () => {
  it("SessionCode lookup does not substitute for invite secret", () => {
    const rendezvous = new LocalRelayRendezvous();
    rendezvous.register({
      sessionCode: "PM-ABC123",
      relayUrl: "ws://127.0.0.1:1/relay",
      relaySessionId: createRelaySessionId(randomBytes),
      relayAccessToken: createRelayAccessToken(randomBytes)
    });
    const record = rendezvous.lookup("PM-ABC123");
    expect(record?.relaySessionId.startsWith("rly_")).toBe(true);
    // Invite secret is intentionally absent from rendezvous metadata.
    expect(record && "inviteSecret" in record).toBe(false);
  });
});

describe("reconnect semantics", () => {
  it("allows reconnect with fresh E2E counters without re-pairing keys", async () => {
    const relay = new MockPairMeshRelay();
    const { url: relayUrl } = await relay.listen();
    const session = relay.createSession();
    const paulKp = generateTransportKeyPair();
    const kelvinKp = generateTransportKeyPair();

    const mk = (side: "paul" | "kelvin") =>
      new E2ETransportSession(
        deriveDirectionalKeys({
          localPrivateKey: side === "paul" ? paulKp.privateKey : kelvinKp.privateKey,
          peerPublicKey: side === "paul" ? kelvinKp.publicKey : paulKp.publicKey,
          sessionId: "ses_re",
          localParticipantId: side,
          peerParticipantId: side === "paul" ? "kelvin" : "paul"
        })
      );

    const paul1 = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: mk("paul"),
      connectionId: "conn_paul_1"
    });
    const kelvin = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: mk("kelvin"),
      connectionId: "conn_kelvin"
    });
    await kelvin.connect();
    await paul1.connect();
    await paul1.close();

    // Reconnect with new directional counters (safe nonce restart after rekey/session object).
    const paul2 = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: mk("paul"),
      connectionId: "conn_paul_2"
    });
    let got = false;
    kelvin.onPlaintext((p) => {
      if (new TextDecoder().decode(p) === "after-reconnect") got = true;
    });
    // Kelvin also needs matching receive state — for prototype, recreate kelvin e2e paired counters.
    await kelvin.close();
    const kelvin2 = new PairMeshRelayClient({
      relayUrl,
      relaySessionId: session.relaySessionId,
      relayAccessToken: session.relayAccessToken,
      e2e: mk("kelvin"),
      connectionId: "conn_kelvin_2"
    });
    kelvin2.onPlaintext((p) => {
      if (new TextDecoder().decode(p) === "after-reconnect") got = true;
    });
    await kelvin2.connect();
    await paul2.connect();
    await paul2.sendPlaintext(new TextEncoder().encode("after-reconnect"));
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(true);

    await paul2.close();
    await kelvin2.close();
    await relay.close();
  });
});
