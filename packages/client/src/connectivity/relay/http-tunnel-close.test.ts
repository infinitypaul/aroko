import { describe, expect, it } from "vitest";
import { RelayHttpEgress } from "./http-tunnel.js";
import type { PairMeshRelayClient } from "./client.js";

function mockRelayClient(sendPlaintext: PairMeshRelayClient["sendPlaintext"]): PairMeshRelayClient {
  return {
    id: "conn_test",
    sendPlaintext,
    onPlaintext: () => () => undefined,
    close: async () => undefined,
    setE2E: () => undefined,
    announcePublicKey: () => undefined,
    terminateForTest: () => undefined,
    tickLivenessForTest: () => undefined
  } as unknown as PairMeshRelayClient;
}

describe("RelayHttpEgress.close", () => {
  it("does not leave orphan pending rejections when sendPlaintext fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const egress = new RelayHttpEgress(
        mockRelayClient(async () => {
          throw new Error("relay_send_failed");
        }),
        "joiner",
        { requestTimeoutMs: 80 }
      );
      const url = await egress.listen();

      const responsePromise = fetch(`${url}/health`).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await egress.close();
      await responsePromise;
      // Wait past the short timeout — prior bug left the timer live after send failure.
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects in-flight tunnel waiters without unhandled rejection on close", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const egress = new RelayHttpEgress(
        mockRelayClient(async () => {
          /* send succeeds; response never arrives until close() */
        }),
        "joiner",
        { requestTimeoutMs: 5_000 }
      );
      const url = await egress.listen();

      const responsePromise = fetch(`${url}/health`).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await egress.close();
      await responsePromise;

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("tunnel timeout does not produce unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const egress = new RelayHttpEgress(
        mockRelayClient(async () => {
          /* send ok; never reply */
        }),
        "joiner",
        { requestTimeoutMs: 50 }
      );
      const url = await egress.listen();
      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).toMatch(/timeout/i);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await egress.close();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
