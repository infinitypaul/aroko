import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { allocateEphemeralPort, allocateEphemeralPortPair } from "./test-ports.js";

describe("S23-7U ephemeral test ports", () => {
  it("allocates a free port the OS accepts for listen", async () => {
    const port = await allocateEphemeralPort();
    expect(port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
  });

  it("allocates distinct ports for a pair (regression vs shared random ranges)", async () => {
    const ports = new Set<number>();
    for (let i = 0; i < 12; i += 1) {
      const { a, b } = await allocateEphemeralPortPair();
      expect(a).not.toBe(b);
      ports.add(a);
      ports.add(b);
    }
    // High likelihood of unique OS assignments across iterations.
    expect(ports.size).toBeGreaterThan(12);
  });
});
