import { createServer } from "node:net";

/**
 * Allocate an ephemeral loopback port via the OS (`listen(0)`).
 *
 * Prefer this over random ports in a shared numeric range — parallel Vitest
 * files (A2A + MCP) previously collided inside 46000–48000 (EADDRINUSE).
 *
 * There is a brief TOCTOU window between close and the caller's listen; callers
 * that need hard guarantees should retry on EADDRINUSE.
 */
export async function allocateEphemeralPort(host = "127.0.0.1"): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Allocate two distinct ephemeral ports (for paired A2A agents).
 */
export async function allocateEphemeralPortPair(
  host = "127.0.0.1"
): Promise<{ a: number; b: number }> {
  const a = await allocateEphemeralPort(host);
  let b = await allocateEphemeralPort(host);
  let attempts = 0;
  while (b === a && attempts < 8) {
    b = await allocateEphemeralPort(host);
    attempts += 1;
  }
  if (b === a) {
    throw new Error("failed to allocate two distinct ephemeral ports");
  }
  return { a, b };
}
