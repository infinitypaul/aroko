import { HostedPairMeshRelay } from "@pairmesh/client";

const port = Number(process.env.PAIRMESH_RELAY_PORT ?? 8787);
const host = process.env.PAIRMESH_RELAY_HOST ?? "0.0.0.0";
const publicWsUrl = process.env.PAIRMESH_RELAY_PUBLIC_WS_URL?.trim();

const relay = new HostedPairMeshRelay({
  publicWsUrl,
  log: (event, fields) => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...fields
      })
    );
  }
});

console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    event: "process_start",
    role: "pairmesh-relay",
    bind: host,
    port,
    publicWsUrl: publicWsUrl ?? null,
    node: process.version
  })
);

const bound = await relay.listen(host, port);
console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    event: "process_ready",
    role: "pairmesh-relay",
    bind: host,
    port: bound.port,
    localUrl: `ws://127.0.0.1:${bound.port}/relay`,
    publicWsUrl: publicWsUrl ?? null,
    health: `http://127.0.0.1:${bound.port}/health`,
    ready: `http://127.0.0.1:${bound.port}/ready`,
    metrics: `http://127.0.0.1:${bound.port}/metrics`,
    note: "content-blind relay — TLS expected at edge"
  })
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "process_signal",
      signal
    })
  );
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
