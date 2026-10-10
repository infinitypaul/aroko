#!/usr/bin/env tsx
/**
 * Optional manual demo: invoke Cursor ACP against a local workspace.
 * Requires `agent login` and `agent` in PATH. Not run by CI.
 */
import { resolve } from "node:path";
import { CursorAcpAdapter } from "@pairmesh/client";

const workspace =
  process.env.PAIRMESH_WORKSPACE?.trim() || resolve(process.cwd(), "fixtures", "payment-workspace");
const question =
  process.argv.slice(2).join(" ").trim() ||
  "What fields does the successful payment response contain?";

async function main(): Promise<void> {
  const adapter = new CursorAcpAdapter({
    workspace,
    mode: "ask",
    timeoutMs: Number(process.env.PAIRMESH_CODING_AGENT_TIMEOUT_MS ?? 120_000),
    command: process.env.PAIRMESH_CURSOR_COMMAND?.trim() || "agent",
    args: (process.env.PAIRMESH_CURSOR_ARGS ?? "acp").split(/\s+/).filter(Boolean)
  });

  console.error(`Workspace: ${workspace}`);
  console.error(`Question: ${question}`);
  console.error("Starting Cursor ACP inspection…");

  const result = await adapter.inspect({
    requestId: `demo_${Date.now()}`,
    question
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
