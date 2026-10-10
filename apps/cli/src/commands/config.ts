import {
  findProjectConfigFile,
  loadConfigFile,
  projectConfigSearchRoot,
  updateLocalConfigFile
} from "@pairmesh/client";
import { requireFlag } from "../args.js";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";

function notInitializedError(): Error {
  return new Error(
    `${productDisplayName()} is not initialized for this project. Run: ${cliBinaryLabel()} init --workspace .`
  );
}

export async function runConfigShowCommand(): Promise<void> {
  const configPath =
    (await findProjectConfigFile(projectConfigSearchRoot())) ??
    (await findProjectConfigFile(process.cwd()));
  if (!configPath) {
    throw notInitializedError();
  }
  const config = await loadConfigFile(configPath);
  console.log(JSON.stringify(config, null, 2));
}

export async function runConfigSetCommand(flags: Record<string, string>): Promise<void> {
  const key = requireFlag(flags, "key");
  const value = requireFlag(flags, "value");
  const configPath =
    (await findProjectConfigFile(projectConfigSearchRoot())) ??
    (await findProjectConfigFile(process.cwd()));
  if (!configPath) {
    throw notInitializedError();
  }

  await updateLocalConfigFile(configPath, (current) => {
    switch (key) {
      case "agent.name":
        return { ...current, agent: { ...current.agent, name: value } };
      case "agent.port": {
        const port = value.toLowerCase() === "auto" ? "auto" : Number(value);
        if (port !== "auto" && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
          throw new Error(`Invalid port: ${value}`);
        }
        return { ...current, agent: { ...current.agent, port } };
      }
      case "agent.bindHost":
        return { ...current, agent: { ...current.agent, bindHost: value } };
      case "agent.advertise":
        return { ...current, agent: { ...current.agent, advertise: value } };
      case "codingAgent.provider": {
        const provider = value.trim().toLowerCase();
        if (
          provider !== "cursor" &&
          provider !== "gemini-cli" &&
          provider !== "claude-code" &&
          provider !== "fake"
        ) {
          throw new Error(
            `Invalid codingAgent.provider: ${value}. Use cursor, gemini-cli, claude-code, or fake.`
          );
        }
        return {
          ...current,
          codingAgent: { ...current.codingAgent, provider }
        };
      }
      case "codingAgent.mode": {
        const mode = value.trim().toLowerCase();
        if (mode !== "ask" && mode !== "plan" && mode !== "agent") {
          throw new Error(`Invalid codingAgent.mode: ${value}. Use ask, plan, or agent.`);
        }
        return {
          ...current,
          codingAgent: { ...current.codingAgent, mode }
        };
      }
      case "connectivity.mode": {
        const mode = value.trim().toLowerCase();
        if (mode !== "direct-url" && mode !== "overlay" && mode !== "relay") {
          throw new Error(
            `Invalid connectivity.mode: ${value}. Use direct-url, overlay, or relay.`
          );
        }
        return {
          ...current,
          connectivity: { ...current.connectivity, mode }
        };
      }
      case "connectivity.relayUrl": {
        const url = value.trim();
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`Invalid connectivity.relayUrl: ${value}`);
        }
        if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
          throw new Error("connectivity.relayUrl must be a ws:// or wss:// URL");
        }
        return {
          ...current,
          connectivity: {
            ...current.connectivity,
            mode: current.connectivity?.mode ?? "relay",
            relayUrl: url
          }
        };
      }
      default:
        throw new Error(
          `Unsupported config key '${key}'. Supported: agent.name, agent.port, agent.bindHost, agent.advertise, codingAgent.provider, codingAgent.mode, connectivity.mode, connectivity.relayUrl`
        );
    }
  });

  console.log(`Updated ${key}.`);
}

export async function runConfigUnsetCommand(flags: Record<string, string>): Promise<void> {
  const key = requireFlag(flags, "key");
  const configPath =
    (await findProjectConfigFile(projectConfigSearchRoot())) ??
    (await findProjectConfigFile(process.cwd()));
  if (!configPath) {
    throw notInitializedError();
  }

  await updateLocalConfigFile(configPath, (current) => {
    switch (key) {
      case "connectivity.relayUrl": {
        if (!current.connectivity?.relayUrl) {
          return current;
        }
        return {
          ...current,
          connectivity: {
            mode: current.connectivity.mode ?? "relay"
          }
        };
      }
      case "agent.bindHost": {
        if (current.agent.bindHost === undefined) {
          return current;
        }
        return {
          ...current,
          agent: {
            name: current.agent.name,
            port: current.agent.port,
            ...(current.agent.advertise ? { advertise: current.agent.advertise } : {})
          }
        };
      }
      case "agent.advertise": {
        if (current.agent.advertise === undefined) {
          return current;
        }
        return {
          ...current,
          agent: {
            name: current.agent.name,
            port: current.agent.port,
            ...(current.agent.bindHost ? { bindHost: current.agent.bindHost } : {})
          }
        };
      }
      default:
        throw new Error(
          `Unsupported config unset key '${key}'. Supported: connectivity.relayUrl, agent.bindHost, agent.advertise`
        );
    }
  });

  console.log(`Unset ${key}.`);
}

export function runConfigHelp(subcommand?: string): void {
  const bin = cliBinaryLabel();
  if (subcommand === "show") {
    console.log(`Usage: ${bin} config show`);
    return;
  }
  if (subcommand === "set") {
    console.log(`Usage: ${bin} config set --key <key> --value <value>`);
    console.log("");
    console.log("Keys:");
    console.log("  agent.name");
    console.log("  agent.port");
    console.log("  agent.bindHost");
    console.log("  agent.advertise");
    console.log("  codingAgent.provider");
    console.log("  codingAgent.mode");
    console.log("  connectivity.mode");
    console.log("  connectivity.relayUrl  (optional override; default hosted relay when omitted)");
    return;
  }
  if (subcommand === "unset") {
    console.log(`Usage: ${bin} config unset --key <key>`);
    console.log("");
    console.log("Removes an optional override so product defaults apply again.");
    console.log("Keys:");
    console.log("  connectivity.relayUrl  (falls back to hosted relay wss://relay.aroko.dev/)");
    console.log("  agent.bindHost");
    console.log("  agent.advertise");
    return;
  }
  console.log("Usage:");
  console.log(`  ${bin} config show`);
  console.log(`  ${bin} config set --key <key> --value <value>`);
  console.log(`  ${bin} config unset --key <key>`);
}
