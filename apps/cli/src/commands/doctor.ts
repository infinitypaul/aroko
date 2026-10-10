import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  describeAdvertisedAddress,
  fetchLocalHealth,
  inspectCursorMcpSetup,
  inspectManagedRuntime,
  readRuntimeInfo,
  resolveLocalRuntime,
  runtimeLogFilePath
} from "@pairmesh/client";
import { relative } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flagValue } from "../args.js";
import { resolveCommandWorkspace } from "../workspace.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { cliBinaryLabel, detectCliInvocationName } from "../cli-brand.js";
import { readArokoBuildInfo, readCliVersion } from "../version.js";

const execFileAsync = promisify(execFile);

export async function runDoctorCommand(flags: Record<string, string> = {}): Promise<void> {
  console.log("Aroko Doctor");
  console.log("");

  reportInstallIdentity();

  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  try {
    await ensureRuntimeUpgradeForCommand(workspace, { quiet: true });
  } catch (error) {
    printLine(
      "Upgrade",
      "incompatible",
      error instanceof Error ? error.message.split("\n")[0] : String(error)
    );
  }

  let runtime;
  try {
    runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    printLine("Config", "OK");
    printLine("Workspace", "OK");
  } catch {
    printLine("Config", "missing", `Run: ${cliBinaryLabel()} init`);
    console.log("");
    return;
  }

  const runtimeInfo = await readRuntimeInfo(runtime.workspace);
  const inspection = await inspectManagedRuntime(runtime.workspace, runtime.config, runtimeInfo);

  if (inspection.verified && runtimeInfo) {
    const modeLabel =
      runtimeInfo.mode === "background" ? "running (background)" : "running (foreground)";
    printLine("Runtime", modeLabel);
    printLine("PID", String(runtimeInfo.pid));

    const peerUrl = runtimeInfo.advertisedUrl ?? runtimeInfo.baseUrl;
    printLine("Advertised address", describeAdvertisedAddress(peerUrl));

    const health = inspection.health ?? (await fetchLocalHealth(runtimeInfo.baseUrl));
    if (health) {
      printLine("A2A health", health.status);
      if (!health.readyForInspection && health.codingAgent?.reason) {
        console.log(`  Reason: ${health.codingAgent.reason}`);
      }
    } else {
      printLine("A2A health", "unreachable");
    }

    const logRelative = relative(runtime.workspace, runtimeLogFilePath(runtime.workspace));
    printLine("Logs", logRelative);
  } else if (inspection.stale) {
    printLine("Runtime", "stale metadata", `${cliBinaryLabel()} start`);
  } else {
    printLine("Runtime", "not running", `${cliBinaryLabel()} start`);
  }

  await reportAudit(runtime.workspace);
  await reportConnectivity(runtime);
  await reportCodingAgent(runtime.codingAgentProvider);
  await reportSession(runtime.workspace);
  await reportCursorMcp(runtime.workspace);
  console.log("");
}

async function reportConnectivity(
  runtime: Awaited<ReturnType<typeof resolveLocalRuntime>>
): Promise<void> {
  const mode = runtime.config.connectivity?.mode ?? "direct-url";
  printLine("Connectivity", mode);
  if (mode !== "relay") {
    return;
  }
  const { describeRelayWsUrl } = await import("@pairmesh/client");
  printLine("Relay endpoint", describeRelayWsUrl(runtime.config));
  const runtimeInfo = await readRuntimeInfo(runtime.workspace);
  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    printLine("Relay", "runtime control unavailable");
    return;
  }
  try {
    const { ControlHttpClient, formatReliabilityDoctorLines, PAIRMESH_BUILD_ID } =
      await import("@pairmesh/client");
    const client = new ControlHttpClient({
      baseUrl: runtimeInfo.controlUrl,
      controlToken: runtimeInfo.controlToken
    });
    const status = await client.getRelayStatus();
    printLine("Relay", formatRelayLifecycle(status));
    printLine("Peer", formatRelayPeerLine(status));
    const controlStatus = await client.getStatus();
    if (controlStatus.buildId) {
      printLine("Runtime build", controlStatus.buildId);
    } else {
      printLine("Runtime build", PAIRMESH_BUILD_ID);
    }
    for (const line of formatReliabilityDoctorLines(controlStatus.reliability ?? {})) {
      const [label, ...rest] = line.split(": ");
      printLine(label ?? "Reliability", rest.join(": ") || line);
    }
  } catch {
    printLine("Relay", "unavailable");
  }
}

function formatRelayLifecycle(status: Record<string, unknown>): string {
  const lifecycle = typeof status.lifecycle === "string" ? status.lifecycle : undefined;
  switch (lifecycle) {
    case "ready":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
    case "connected":
    case "e2e_negotiating":
      return "connecting";
    case "offline":
      return "unavailable";
    case "auth_failed":
      return "authentication failed";
    case "stopped":
      return "stopped";
    default:
      return status.connected === true ? "connected" : "connecting";
  }
}

function formatRelayPeerLine(status: Record<string, unknown>): string {
  const lifecycle = typeof status.lifecycle === "string" ? status.lifecycle : "";
  if (lifecycle === "reconnecting" || lifecycle === "offline" || lifecycle === "auth_failed") {
    return "unreachable";
  }
  if (lifecycle === "e2e_negotiating" || lifecycle === "connecting") {
    return "waiting";
  }
  return status.peerReady === true ? "ready" : "waiting";
}

function reportInstallIdentity(): void {
  const info = readArokoBuildInfo();
  const invocation = detectCliInvocationName();
  printLine("Product", `${info.product ?? "Aroko"} ${readCliVersion()}`);
  printLine("CLI name", invocation);
  printLine("Release", info.releaseId ?? "unknown");
  printLine("Commit", (info.gitCommit ?? "unknown").slice(0, 12));
  if (info.artifactSha256) {
    printLine("Artifact", `${info.artifactSha256.slice(0, 16)}…`);
  }
  try {
    const entry = realpathSync(fileURLToPath(import.meta.url));
    printLine("Install path", entry);
  } catch {
    printLine("Install path", fileURLToPath(import.meta.url));
  }
  printLine("Binary", cliBinaryLabel());
  console.log("");
}

function printLine(label: string, value: string, fix?: string): void {
  const dots = ".".repeat(Math.max(1, 22 - label.length));
  console.log(`${label} ${dots} ${value}`);
  if (fix) {
    console.log("");
    console.log("Fix:");
    console.log(`  ${fix}`);
  }
}

async function reportAudit(workspace: string): Promise<void> {
  try {
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    const health = manager.getAuditHealth();
    if (health.status === "ready") {
      printLine("Audit", "ready");
    } else if (health.status === "degraded") {
      printLine("Audit", "degraded");
      if (health.reason) {
        console.log(`  ${health.reason}`);
      }
    } else {
      printLine("Audit", "missing");
    }
  } catch {
    printLine("Audit", "ready");
  }
}

async function reportCodingAgent(provider: string): Promise<void> {
  const bin = cliBinaryLabel();
  printLine("Provider", provider);

  if (provider === "fake") {
    printLine("Executable", "n/a (in-process)");
    printLine("Integration", "ready (TEST_ONLY)");
    printLine("Authentication", "none");
    return;
  }

  const probes: Record<string, { label: string; command: string; args: string[]; fix: string }> = {
    "gemini-cli": {
      label: "Gemini CLI",
      command: "gemini",
      args: ["--version"],
      fix: `Install Gemini CLI (\`npm i -g @google/gemini-cli\`) and authenticate it.\n  Then: ${bin} config set --key codingAgent.provider --value gemini-cli\n  ${bin} restart`
    },
    "claude-code": {
      label: "Claude Code",
      command: "claude",
      args: ["--version"],
      fix: `Install Claude Code CLI and authenticate it (\`claude\`).\n  Then: ${bin} config set --key codingAgent.provider --value claude-code\n  ${bin} restart`
    },
    cursor: {
      label: "Cursor ACP",
      command: "agent",
      args: ["--version"],
      fix: `Install Cursor CLI and ensure \`agent\` is in PATH.\n  agent login\n  Then: ${bin} config set --key codingAgent.provider --value cursor\n  ${bin} restart`
    }
  };

  const probe = probes[provider] ?? probes.cursor;
  printLine("Provider name", probe.label);
  try {
    const { stdout } = await execFileAsync(probe.command, probe.args);
    const version = stdout.trim().split("\n")[0] ?? "found";
    printLine("Executable", `found (${probe.command})`);
    printLine("Version", version.slice(0, 80));
    printLine("Integration", "ready");
    printLine("Authentication", "provider-managed — verify in provider CLI");
  } catch {
    printLine("Executable", `not found (${probe.command})`);
    printLine("Integration", "unavailable", probe.fix);
  }
}

async function reportSession(workspace: string): Promise<void> {
  try {
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    const status = await manager.getSessionStatus();
    printLine("Session", status.sessionCode);
    printLine(
      "Session auth",
      status.security.authenticated
        ? `${status.security.securityVersion} (${status.security.activeCredentials.length} credential(s))`
        : "re-pair required"
    );
    if (!status.security.authenticated) {
      console.log("");
      console.log("Fix:");
      console.log(`  ${cliBinaryLabel()} leave`);
      console.log(`  ${cliBinaryLabel()} create   # then re-share the invite`);
    }

    // Prefer Control peers when runtime is up — routeHealth lives in the runtime process.
    const peers = await loadDoctorPeers(workspace, manager);
    if (peers.length > 0) {
      printLine("Peers", String(peers.length));
      let ready = 0;
      let reachable = 0;
      let unpaired = 0;
      let offline = 0;
      for (const peer of peers) {
        if (peer.relationship !== "paired") {
          unpaired += 1;
        }
        if (peer.connectivity === "ready") {
          reachable += 1;
          if (peer.agent === "ready") {
            ready += 1;
          }
        } else if (peer.connectivity === "offline") {
          offline += 1;
        } else if (peer.connectivity === "reconnecting") {
          reachable += 1;
        }
      }
      printLine(
        "Peer health",
        `${ready} ready / ${reachable} reachable / ${unpaired} unpaired / ${offline} offline of ${peers.length}`
      );
      for (const peer of peers) {
        const agentLabel = peer.agent ? ` · agent ${peer.agent}` : "";
        console.log(
          `  ${peer.displayName}${peer.service ? ` (${peer.service})` : ""} · trust ${peer.relationship} · connection ${peer.connectivity}${agentLabel}`
        );
      }
    } else {
      printLine("Peers", "(none)");
    }
  } catch {
    printLine("Session", "none");
  }
}

type DoctorPeerRow = {
  displayName: string;
  service?: string;
  relationship: string;
  connectivity: string;
  agent?: string;
};

async function loadDoctorPeers(
  workspace: string,
  manager: Awaited<ReturnType<typeof createSessionManagerFromResolvedConfig>>
): Promise<DoctorPeerRow[]> {
  const runtimeInfo = await readRuntimeInfo(workspace);
  if (runtimeInfo?.controlUrl && runtimeInfo.controlToken) {
    try {
      const { ControlHttpClient } = await import("@pairmesh/client");
      const client = new ControlHttpClient({
        baseUrl: runtimeInfo.controlUrl,
        controlToken: runtimeInfo.controlToken
      });
      const { peers } = await client.listPeers();
      return peers.map((peer) => ({
        displayName: peer.displayName,
        ...(peer.service ? { service: peer.service } : {}),
        relationship: peer.relationship,
        connectivity: peer.connectivity ?? "unknown",
        ...(peer.agent ? { agent: peer.agent } : {})
      }));
    } catch {
      /* fall through to local listSafePeers */
    }
  }
  const safePeers = await manager.listSafePeers();
  return safePeers.map((peer) => ({
    displayName: peer.displayName,
    ...(peer.service ? { service: peer.service } : {}),
    relationship: peer.relationship,
    connectivity: peer.connectivity,
    ...(peer.agent ? { agent: peer.agent } : {})
  }));
}

async function reportCursorMcp(workspace: string): Promise<void> {
  const inspection = await inspectCursorMcpSetup(workspace);
  const targetRelative = relative(workspace, inspection.targetPath) || ".cursor/mcp.json";

  switch (inspection.status) {
    case "configured":
      printLine("Cursor MCP", "configured");
      return;
    case "missing":
      printLine("Cursor MCP", "missing", `${cliBinaryLabel()} cursor setup --write`);
      return;
    case "invalid":
      printLine("Cursor MCP", "invalid");
      console.log("");
      console.log(`${targetRelative} contains invalid JSON.`);
      console.log("");
      console.log("Fix the file and rerun:");
      console.log(`  ${cliBinaryLabel()} cursor setup --write`);
      return;
    case "conflict":
      printLine("Cursor MCP", "conflict");
      console.log("");
      console.log(
        "Aroko is configured in Cursor, but the command differs from the current project configuration."
      );
      console.log("");
      console.log("Review:");
      console.log(`  ${cliBinaryLabel()} cursor setup`);
      return;
  }
}
