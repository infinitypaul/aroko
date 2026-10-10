import { createServer } from "node:net";

export const DEFAULT_PORT_RANGE_START = 47_100;
export const DEFAULT_PORT_RANGE_END = 47_150;

export async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host, port }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export async function pickAvailablePort(
  host: string,
  preferred?: number,
  rangeStart = DEFAULT_PORT_RANGE_START,
  rangeEnd = DEFAULT_PORT_RANGE_END
): Promise<number> {
  if (preferred !== undefined && (await isPortAvailable(host, preferred))) {
    return preferred;
  }

  for (let port = rangeStart; port <= rangeEnd; port += 1) {
    if (await isPortAvailable(host, port)) {
      return port;
    }
  }

  throw new Error(`No available PairMesh port found in range ${rangeStart}-${rangeEnd}.`);
}
