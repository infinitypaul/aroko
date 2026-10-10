import { describe, expect, it } from "vitest";
import { RelayHttpEgress, isRelayHttpTransportProbe } from "./http-tunnel.js";
import type { PairMeshRelayClient, RelaySendDestination } from "./client.js";

function mockRelayClient(
  sendPlaintext: PairMeshRelayClient["sendPlaintext"],
  onPlaintext?: PairMeshRelayClient["onPlaintext"]
): PairMeshRelayClient {
  return {
    id: "conn_test",
    sendPlaintext,
    onPlaintext: onPlaintext ?? (() => () => undefined),
    close: async () => undefined,
    setE2E: () => undefined,
    announcePublicKey: () => undefined,
    terminateForTest: () => undefined,
    tickLivenessForTest: () => undefined
  } as unknown as PairMeshRelayClient;
}

describe("half-open route transport probes (Stage 18 Prompt 7)", () => {
  it("isRelayHttpTransportProbe classifies health/agent-card only", () => {
    expect(isRelayHttpTransportProbe("GET", "/health")).toBe(true);
    expect(isRelayHttpTransportProbe("GET", "/.well-known/agent-card.json")).toBe(true);
    expect(isRelayHttpTransportProbe("POST", "/health")).toBe(false);
    expect(isRelayHttpTransportProbe("POST", "/")).toBe(false);
    expect(isRelayHttpTransportProbe("GET", "/v1/message:send")).toBe(false);
  });

  it("H1: open-looking route with no forward progress fails fast on /health", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const stalls: Array<{ attempt: number }> = [];
    try {
      const egress = new RelayHttpEgress(
        mockRelayClient(async () => {
          /* send ok; never reply */
        }),
        "joiner",
        {
          requestTimeoutMs: 5_000,
          transportProbeTimeoutMs: 40,
          onTransportStall: (info) => {
            stalls.push({ attempt: info.attempt });
            return { kind: "fail" };
          }
        }
      );
      const url = await egress.listen();
      const started = Date.now();
      const res = await fetch(`${url}/health`);
      const elapsed = Date.now() - started;
      expect(res.status).toBe(502);
      expect(elapsed).toBeLessThan(2_000);
      expect(stalls.length).toBe(1);
      await egress.close();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("H2: hung old route rebinds to newer connectionId and health succeeds", async () => {
    let plaintextHandler: ((data: Uint8Array) => void) | null = null;
    let sendCount = 0;
    let currentDest: RelaySendDestination | undefined = {
      toParticipantId: "join_old",
      toConnectionId: "conn_old_aaaa",
      channelId: "ch_1"
    };

    const egress = new RelayHttpEgress(
      mockRelayClient(
        async (_plaintext, dest) => {
          sendCount += 1;
          currentDest = dest ? { ...dest } : currentDest;
          if (sendCount === 1) {
            // first forward never completes
            return;
          }
          // Second send (after rebind): synthesize http_response for pending correlation.
          const msg = JSON.parse(new TextDecoder().decode(_plaintext)) as {
            correlationId: string;
          };
          queueMicrotask(() => {
            plaintextHandler?.(
              new TextEncoder().encode(
                JSON.stringify({
                  kind: "http_response",
                  correlationId: msg.correlationId,
                  statusCode: 200,
                  headers: { "content-type": "application/json" },
                  bodyB64: Buffer.from(JSON.stringify({ status: "ready" })).toString("base64")
                })
              )
            );
          });
        },
        (handler) => {
          plaintextHandler = handler;
          return () => {
            plaintextHandler = null;
          };
        }
      ),
      "joiner",
      {
        sendDest: currentDest,
        transportProbeTimeoutMs: 40,
        onTransportStall: () => {
          const next: RelaySendDestination = {
            toParticipantId: "join_old",
            toConnectionId: "conn_new_bbbb",
            channelId: "ch_1"
          };
          return { kind: "retry", sendDest: next };
        }
      }
    );

    const url = await egress.listen();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(sendCount).toBe(2);
    expect(egress.getSendDestForTest()?.toConnectionId).toBe("conn_new_bbbb");
    await egress.close();
  });

  it("H3: hung route with no replacement becomes fail-fast unavailable (no infinite hang)", async () => {
    const egress = new RelayHttpEgress(
      mockRelayClient(async () => undefined),
      "joiner",
      {
        transportProbeTimeoutMs: 40,
        onTransportStall: () => ({ kind: "fail" })
      }
    );
    const url = await egress.listen();
    const started = Date.now();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
    await egress.close();
  });

  it("H4: slow application path does NOT trigger transport stall recovery", async () => {
    let stallCalls = 0;
    const egress = new RelayHttpEgress(
      mockRelayClient(async () => undefined),
      "joiner",
      {
        requestTimeoutMs: 80,
        transportProbeTimeoutMs: 20,
        onTransportStall: () => {
          stallCalls += 1;
          return { kind: "fail" };
        }
      }
    );
    const url = await egress.listen();
    const res = await fetch(`${url}/v1/message:send`, {
      method: "POST",
      body: "{}"
    });
    expect(res.status).toBe(502);
    expect(stallCalls).toBe(0);
    await egress.close();
  });

  it("H5: recovered route after connection refresh — retry succeeds", async () => {
    let plaintextHandler: ((data: Uint8Array) => void) | null = null;
    let sendCount = 0;
    const egress = new RelayHttpEgress(
      mockRelayClient(
        async (plaintext) => {
          sendCount += 1;
          if (sendCount >= 2) {
            const msg = JSON.parse(new TextDecoder().decode(plaintext)) as {
              correlationId: string;
            };
            queueMicrotask(() => {
              plaintextHandler?.(
                new TextEncoder().encode(
                  JSON.stringify({
                    kind: "http_response",
                    correlationId: msg.correlationId,
                    statusCode: 200,
                    headers: { "content-type": "text/plain" },
                    bodyB64: Buffer.from("ok").toString("base64")
                  })
                )
              );
            });
          }
        },
        (handler) => {
          plaintextHandler = handler;
          return () => {
            plaintextHandler = null;
          };
        }
      ),
      "joiner",
      {
        transportProbeTimeoutMs: 40,
        onTransportStall: () => ({ kind: "retry" })
      }
    );
    const url = await egress.listen();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(sendCount).toBe(2);
    await egress.close();
  });

  it("H6: concurrent peers — stall handler is per-egress (Sarah untouched)", async () => {
    const kelvinStalls: string[] = [];
    const sarahStalls: string[] = [];

    const kelvin = new RelayHttpEgress(
      mockRelayClient(async () => undefined),
      "joiner",
      {
        transportProbeTimeoutMs: 40,
        onTransportStall: () => {
          kelvinStalls.push("kelvin");
          return { kind: "fail" };
        }
      }
    );
    let sarahPlaintext: ((data: Uint8Array) => void) | null = null;
    const sarah = new RelayHttpEgress(
      mockRelayClient(
        async (plaintext) => {
          const msg = JSON.parse(new TextDecoder().decode(plaintext)) as {
            correlationId: string;
          };
          queueMicrotask(() => {
            sarahPlaintext?.(
              new TextEncoder().encode(
                JSON.stringify({
                  kind: "http_response",
                  correlationId: msg.correlationId,
                  statusCode: 200,
                  headers: { "content-type": "text/plain" },
                  bodyB64: Buffer.from("ok").toString("base64")
                })
              )
            );
          });
        },
        (handler) => {
          sarahPlaintext = handler;
          return () => {
            sarahPlaintext = null;
          };
        }
      ),
      "joiner",
      {
        transportProbeTimeoutMs: 200,
        onTransportStall: () => {
          sarahStalls.push("sarah");
          return { kind: "fail" };
        }
      }
    );

    const kelvinUrl = await kelvin.listen();
    const sarahUrl = await sarah.listen();
    const [kelvinRes, sarahRes] = await Promise.all([
      fetch(`${kelvinUrl}/health`),
      fetch(`${sarahUrl}/health`)
    ]);
    expect(kelvinRes.status).toBe(502);
    expect(sarahRes.status).toBe(200);
    expect(kelvinStalls).toEqual(["kelvin"]);
    expect(sarahStalls).toHaveLength(0);
    await kelvin.close();
    await sarah.close();
  });
});
