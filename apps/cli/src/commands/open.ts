import { flagValue } from "../args.js";
import { resolveCommandWorkspace } from "../workspace.js";
import { runControlCommand } from "./control.js";

/** Everyday alias: open → control open (Inbox deep-link). */
export async function runOpenCommand(
  flags: Record<string, string>,
  positionals: string[] = []
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  void workspace;
  await runControlCommand(flags, positionals, "open");
}
