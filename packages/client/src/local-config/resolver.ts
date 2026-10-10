import { ProjectIdSchema } from "@pairmesh/protocol";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { projectConfigSearchRoot, resolveConfigFilePath } from "../cursor-mcp/mcp-launch.js";
import {
  configFilePath,
  findProjectConfigFile,
  projectPairMeshDir,
  stateFilePath,
  workspaceBasename
} from "./paths.js";
import { pickAvailablePort } from "./port.js";
import { buildAdvertisedUrl, buildBaseUrl, normalizeBindHost } from "../pairing/address.js";
import { PairMeshProjectNotFoundError } from "./project-resolve.js";
import {
  PAIRMESH_LOCAL_CONFIG_VERSION,
  PairMeshLocalConfigSchema,
  type PairMeshLocalConfig
} from "./schema.js";
import {
  resolveRelayWsUrl,
  isRelayConnectivityMode
} from "../connectivity/hosted-relay-default.js";

export interface ResolvedLocalRuntime {
  config: PairMeshLocalConfig;
  configFilePath: string;
  workspace: string;
  workspaceBasename: string;
  stateFilePath: string;
  agentName: string;
  host: string;
  port: number;
  baseUrl: string;
  agentUrl: string;
  advertisedUrl: string;
  codingAgentProvider: PairMeshLocalConfig["codingAgent"]["provider"];
  codingAgentMode: PairMeshLocalConfig["codingAgent"]["mode"];
  /** Effective relay WebSocket URL when connectivity.mode=relay. */
  relayWsUrl?: string;
}

export interface ResolveLocalRuntimeOptions {
  cwd?: string;
  configFilePath?: string;
  preferredPort?: number;
  cli?: Partial<{
    workspace: string;
    agentName: string;
    port: number | "auto";
    bindHost: string;
    provider: PairMeshLocalConfig["codingAgent"]["provider"];
    mode: PairMeshLocalConfig["codingAgent"]["mode"];
  }>;
}

export interface InitLocalConfigInput {
  workspace: string;
  agentName?: string;
  port?: number | "auto";
  bindHost?: string;
  advertise?: string;
  provider?: PairMeshLocalConfig["codingAgent"]["provider"];
  mode?: PairMeshLocalConfig["codingAgent"]["mode"];
  projectId?: string;
}

export async function initLocalConfig(input: InitLocalConfigInput): Promise<PairMeshLocalConfig> {
  const workspace = resolve(input.workspace);
  await assertDirectoryExists(workspace);

  const existingPath = configFilePath(workspace);
  let existing: PairMeshLocalConfig | null = null;
  try {
    existing = await loadConfigFile(existingPath);
  } catch {
    existing = null;
  }

  const agentName = input.agentName?.trim() || existing?.agent.name || defaultAgentName(workspace);
  const config = PairMeshLocalConfigSchema.parse({
    configVersion: PAIRMESH_LOCAL_CONFIG_VERSION,
    projectId:
      existing?.projectId ?? input.projectId ?? ProjectIdSchema.parse(`prj_${randomUUID()}`),
    agent: {
      name: agentName,
      port: input.port ?? existing?.agent.port ?? "auto",
      ...((input.bindHost ?? existing?.agent.bindHost)
        ? { bindHost: input.bindHost ?? existing?.agent.bindHost }
        : {}),
      ...((input.advertise ?? existing?.agent.advertise)
        ? { advertise: input.advertise ?? existing?.agent.advertise }
        : {})
    },
    workspace,
    codingAgent: {
      provider: input.provider ?? existing?.codingAgent.provider ?? "cursor",
      mode: input.mode ?? existing?.codingAgent.mode ?? "ask"
    },
    connectivity: existing?.connectivity ?? { mode: "relay" }
  });

  await mkdir(projectPairMeshDir(workspace), { recursive: true });
  await writeFile(existingPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function loadConfigFile(path: string): Promise<PairMeshLocalConfig> {
  const raw = await readFile(path, "utf8");
  return PairMeshLocalConfigSchema.parse(JSON.parse(raw));
}

export async function resolveLocalRuntime(
  options: ResolveLocalRuntimeOptions = {}
): Promise<ResolvedLocalRuntime> {
  const cwd = resolve(options.cwd ?? projectConfigSearchRoot());
  const envConfigFile = process.env.PAIRMESH_CONFIG_FILE?.trim();
  const configPath =
    options.configFilePath?.trim() ||
    (envConfigFile ? await resolveConfigFilePath(envConfigFile) : undefined) ||
    (await findProjectConfigFile(cwd));

  if (!configPath) {
    throw new PairMeshProjectNotFoundError();
  }

  const config = await loadConfigFile(configPath);
  const workspace = resolve(
    options.cli?.workspace ?? process.env.PAIRMESH_WORKSPACE ?? config.workspace
  );
  await assertDirectoryExists(workspace);

  const agentName = options.cli?.agentName ?? process.env.PAIRMESH_AGENT_NAME ?? config.agent.name;
  const host = normalizeBindHost(
    options.cli?.bindHost ?? process.env.PAIRMESH_AGENT_HOST?.trim() ?? config.agent.bindHost
  );
  const configuredPort = parsePortOverride(options.cli?.port, config.agent.port);
  const portHint = configuredPort === "auto" ? options.preferredPort : configuredPort;
  const port = await pickAvailablePort(host, portHint);
  const baseUrl = buildBaseUrl(host, port);
  const advertisedUrl = buildAdvertisedUrl({
    bindHost: host,
    port,
    advertise: config.agent.advertise
  });

  return {
    config,
    configFilePath: configPath,
    workspace,
    workspaceBasename: workspaceBasename(workspace),
    stateFilePath: process.env.PAIRMESH_STATE_FILE?.trim() || stateFilePath(workspace),
    agentName,
    host,
    port,
    baseUrl,
    agentUrl: advertisedUrl,
    advertisedUrl,
    codingAgentProvider:
      parseProviderOverride(process.env.PAIRMESH_CODING_AGENT_PROVIDER) ??
      options.cli?.provider ??
      config.codingAgent.provider,
    codingAgentMode:
      parseModeOverride(process.env.PAIRMESH_CODING_AGENT_MODE) ??
      options.cli?.mode ??
      config.codingAgent.mode,
    ...(isRelayConnectivityMode(config) ? { relayWsUrl: resolveRelayWsUrl(config) } : {})
  };
}

export function applyResolvedLocalRuntimeToEnv(runtime: ResolvedLocalRuntime): void {
  process.env.PAIRMESH_WORKSPACE = runtime.workspace;
  process.env.PAIRMESH_STATE_FILE = runtime.stateFilePath;
  process.env.PAIRMESH_CODING_AGENT_PROVIDER = runtime.codingAgentProvider;
  process.env.PAIRMESH_CODING_AGENT_MODE = runtime.codingAgentMode;
  process.env.PAIRMESH_AGENT_NAME = runtime.agentName;
  process.env.PAIRMESH_PROJECT_ID = runtime.config.projectId;
}

export function defaultAgentName(workspace: string): string {
  const name = workspaceBasename(workspace);
  return name.endsWith("-agent") ? name : `${name}-agent`;
}

function parsePortOverride(
  cliPort: number | "auto" | undefined,
  configPort: number | "auto"
): number | "auto" {
  if (cliPort !== undefined) {
    return cliPort;
  }
  const envPort = process.env.PAIRMESH_AGENT_PORT?.trim() || process.env.PORT?.trim();
  if (envPort) {
    if (envPort.toLowerCase() === "auto") {
      return "auto";
    }
    const parsed = Number(envPort);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return configPort;
}

function parseProviderOverride(
  value: string | undefined
): PairMeshLocalConfig["codingAgent"]["provider"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "cursor" ||
    normalized === "fake" ||
    normalized === "gemini-cli" ||
    normalized === "claude-code"
  ) {
    return normalized;
  }
  return undefined;
}

function parseModeOverride(
  value: string | undefined
): PairMeshLocalConfig["codingAgent"]["mode"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "ask" || normalized === "plan" || normalized === "agent") {
    return normalized;
  }
  return undefined;
}

async function assertDirectoryExists(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Workspace does not exist: ${basename(path)}`);
  }
}

export async function updateLocalConfigFile(
  configPath: string,
  updater: (config: PairMeshLocalConfig) => PairMeshLocalConfig
): Promise<PairMeshLocalConfig> {
  const current = await loadConfigFile(configPath);
  const next = PairMeshLocalConfigSchema.parse(updater(current));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
