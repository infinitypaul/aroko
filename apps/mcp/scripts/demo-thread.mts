#!/usr/bin/env tsx
/**
 * Multi-turn inspection thread demo using an existing paired session.
 */
import { LocalStateStore, SessionManager } from "@pairmesh/client";

const stateFile = process.env.PAIRMESH_STATE_FILE?.trim() || "/tmp/pairmesh-paul-p3.json";
const peer = process.argv[2]?.trim() || "kelvin-agent";

async function main(): Promise<void> {
  const manager = new SessionManager({
    stateStore: new LocalStateStore({ stateFilePath: stateFile })
  });

  console.error(`State: ${stateFile}`);
  console.error(`Peer: ${peer}`);

  const turn1 = await manager.askPeer(
    peer,
    "What fields does the successful payment response contain?"
  );
  console.log("Turn 1:", JSON.stringify(turn1, null, 2));

  const turn2 = await manager.followUpInspection(
    turn1.threadId,
    "Where does paymentReference come from?"
  );
  console.log("Turn 2:", JSON.stringify(turn2, null, 2));

  const turn3 = await manager.followUpInspection(
    turn1.threadId,
    "Is customerId transformed before being returned?"
  );
  console.log("Turn 3:", JSON.stringify(turn3, null, 2));

  const threads = await manager.listInspectionThreads();
  console.log("Threads:", JSON.stringify(threads, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
