import { formatAuditEventHuman } from "@pairmesh/client";
import { flagValue } from "../args.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

export async function runAuditCommand(
  flags: Record<string, string>,
  positionals: string[] = []
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const limitRaw = flagValue(flags, "limit") ?? positionals[0];
  const limit = Math.min(200, Math.max(1, Number.parseInt(limitRaw ?? "50", 10) || 50));
  const asJson = flags.json === "true";

  const events = await manager.listAuditEvents(limit);
  if (asJson) {
    console.log(JSON.stringify({ events }, null, 2));
    return;
  }

  if (events.length === 0) {
    console.log("No audit events recorded yet.");
    return;
  }

  for (const event of events) {
    console.log(formatAuditEventHuman(event));
    console.log("");
  }
}
