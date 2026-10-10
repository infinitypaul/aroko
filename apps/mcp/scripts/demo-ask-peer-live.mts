#!/usr/bin/env tsx
/**
 * Live Paul → Kelvin inspect demo using existing paired session state.
 * Same path as pairmesh_ask_peer MCP tool.
 */
import { LocalStateStore, SessionManager } from "@pairmesh/client";

const stateFile = process.env.PAIRMESH_STATE_FILE?.trim() || "/tmp/pairmesh-paul-p3.json";
const peer = process.argv[2]?.trim() || "kelvin-agent";
const question =
  process.argv.slice(3).join(" ").trim() ||
  "What fields does the successful payment response contain?";

async function main(): Promise<void> {
  const manager = new SessionManager({
    stateStore: new LocalStateStore({ stateFilePath: stateFile })
  });

  console.error(`State: ${stateFile}`);
  console.error(`Peer: ${peer}`);
  console.error(`Question: ${question}`);
  console.error("Invoking pairmesh.inspect (live ACP on receiver)…");

  const result = await manager.askPeer(peer, question);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
