import { readRecentLogLines, runtimeLogFilePath } from "@pairmesh/client";
import { relative } from "node:path";
import { flagValue } from "../args.js";
import { resolveCommandWorkspace } from "../workspace.js";

export async function runLogsCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const follow = flags.follow === "true";

  if (follow) {
    console.error("Log follow is not implemented yet. Showing recent lines.");
  }

  const lines = await readRecentLogLines(workspace, 100);
  const logRelative = relative(workspace, runtimeLogFilePath(workspace));

  if (lines.stdout.length === 0 && lines.stderr.length === 0) {
    console.log(`No log output yet (${logRelative}).`);
    return;
  }

  for (const line of lines.stdout) {
    console.log(line);
  }
  for (const line of lines.stderr) {
    console.error(line);
  }
}
