import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlHttpClient, readRuntimeInfo } from "@pairmesh/client";
import { flagValue } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";

const DEFAULT_CANARIES = ["STAGE14_CANARY_PK_9f2e1a", "STAGE14_CANARY_PS_4c8b3d"];

export async function runRelayCommand(
  flags: Record<string, string>,
  positionals: string[] = [],
  subcommand?: string
): Promise<void> {
  const bin = cliBinaryLabel();
  if (subcommand !== "trace") {
    throw new Error(`Unknown relay command. Usage: ${bin} relay trace reset|snapshot`);
  }

  const action = positionals[0];
  if (action !== "reset" && action !== "snapshot") {
    throw new Error(`Usage: ${bin} relay trace reset|snapshot`);
  }

  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    throw new Error(`Control API unavailable — run ${bin} start in this project first.`);
  }

  const client = new ControlHttpClient({
    baseUrl: runtimeInfo.controlUrl,
    controlToken: runtimeInfo.controlToken
  });

  if (action === "reset") {
    const trace = await client.resetRelayTrafficTrace(DEFAULT_CANARIES);
    console.log(JSON.stringify({ action: "reset", trace }, null, 2));
    return;
  }

  const trace = await client.getRelayTrafficTrace();
  if ("mode" in trace && trace.mode === "off") {
    throw new Error(
      `Relay traffic trace unavailable — install the latest ${bin} CLI and ${bin} restart`
    );
  }

  const outPath =
    flagValue(flags, "out")?.trim() || join(workspace, ".pairmesh/relay-traffic-snapshot.json");
  const payload = {
    workspace,
    role: flagValue(flags, "role")?.trim() || "unknown",
    trace
  };
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ action: "snapshot", outPath, trace }, null, 2));
}
