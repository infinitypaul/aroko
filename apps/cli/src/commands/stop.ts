import { stopBackgroundRuntime } from "../runtime/background-runtime.js";
import { flagValue } from "../args.js";
import { productDisplayName } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";

export async function runStopCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const stopped = await stopBackgroundRuntime({
    workspace,
    force: flags.force === "true"
  });

  const product = productDisplayName();
  if (!stopped) {
    console.log(`${product} is not running.`);
    return;
  }

  console.log(`${product} stopped`);
}
