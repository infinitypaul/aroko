import {
  defaultAgentName,
  ensurePairMeshGitignore,
  findProjectConfigFile,
  initLocalConfig,
  type PairMeshLocalConfig
} from "@pairmesh/client";
import { flagValue, parsePortFlag } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { resolveInitWorkspacePath } from "../workspace.js";

export async function runInitCommand(flags: Record<string, string>): Promise<void> {
  const workspace = resolveInitWorkspacePath(flagValue(flags, "workspace"));
  const bin = cliBinaryLabel();
  const hasUpdateFlags = Boolean(
    flagValue(flags, "name") ||
    flagValue(flags, "port") ||
    flagValue(flags, "provider") ||
    flagValue(flags, "mode")
  );

  const existingConfigPath = await findProjectConfigFile(workspace);
  if (existingConfigPath && !hasUpdateFlags) {
    console.log("Aroko is already initialized for this project.");
    console.log("");
    console.log("Config:");
    console.log("  .pairmesh/config.json");
    console.log("");
    console.log("Next:");
    console.log(`  ${bin} cursor setup --write`);
    console.log(`  ${bin} connect`);
    return;
  }

  const agentName = flagValue(flags, "name") ?? defaultAgentName(workspace);
  const port = parsePortFlag(flagValue(flags, "port")) ?? "auto";
  const provider = (flagValue(flags, "provider") ??
    "cursor") as PairMeshLocalConfig["codingAgent"]["provider"];
  const mode = (flagValue(flags, "mode") ?? "ask") as PairMeshLocalConfig["codingAgent"]["mode"];

  const config = await initLocalConfig({
    workspace,
    agentName,
    port,
    provider,
    mode
  });

  const gitignore = await ensurePairMeshGitignore(workspace);

  const projectName = workspace.split(/[/\\]/).filter(Boolean).pop() ?? workspace;
  const portLabel = config.agent.port === "auto" ? "auto" : String(config.agent.port);
  const providerLabel =
    config.codingAgent.provider.charAt(0).toUpperCase() + config.codingAgent.provider.slice(1);

  console.log("Aroko initialized");
  console.log("");
  console.log(`Project: ${projectName}`);
  console.log(`Agent: ${config.agent.name}`);
  console.log(`Coding agent: ${providerLabel}`);
  console.log(`Port: ${portLabel}`);
  console.log("");
  console.log("Created:");
  console.log("  .pairmesh/config.json");
  console.log("");
  console.log("Protected local state:");
  console.log("  .pairmesh/");
  if (gitignore.warning) {
    console.log("");
    console.log(gitignore.warning);
  }
  console.log("");
  console.log("Next:");
  console.log(`  ${bin} cursor setup --write`);
  console.log(`  ${bin} connect`);
}
