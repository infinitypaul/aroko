import {
  applyResolvedLocalRuntimeToEnv,
  clearRuntimeInfo,
  computeRuntimeMetadata,
  configureReliabilityTracker,
  ControlPlane,
  fetchLocalHealth,
  generateControlToken,
  getReliabilityTracker,
  LocalStateStore,
  RelayBridge,
  relayRouteFileFromStateFile,
  SessionManager,
  setRuntimeRelayBridge,
  startControlHttpServer,
  OwnerPresence,
  type ResolvedLocalRuntime,
  writeRuntimeInfo
} from "@pairmesh/client";
import { createPairMeshA2AAgent } from "@pairmesh/coordination/a2a";
import type { PairMeshRuntimeInfo } from "@pairmesh/client";

export interface ForegroundRuntimeOptions {
  runtime: ResolvedLocalRuntime;
  mode: "background" | "foreground";
  logFile?: string;
  verbose?: boolean;
}

export interface ForegroundRuntimeStarted {
  runtimeInfo: PairMeshRuntimeInfo;
  health: Awaited<ReturnType<typeof fetchLocalHealth>> | null;
}

export async function runForegroundRuntime(
  options: ForegroundRuntimeOptions
): Promise<ForegroundRuntimeStarted> {
  const { runtime, mode, logFile, verbose } = options;
  applyResolvedLocalRuntimeToEnv(runtime);
  configureReliabilityTracker({ workspace: runtime.workspace });
  getReliabilityTracker().begin("runtime.start_to_relay_socket", {
    transport: "relay",
    replacePrior: true,
    phase: "runtime_start"
  });

  // R22-1: one authoritative LocalStateStore per runtime process. SessionManager
  // and A2A must share this instance — never construct a second store for the
  // same state.json path in-process.
  const stateStore = new LocalStateStore({ stateFilePath: runtime.stateFilePath });
  // SessionManager + Control must exist before A2A so inbound approval_required
  // transitions share the ActionService that OwnerPresence is hooked to.
  // (A separate A2A ActionService wrote Inbox state but never fired notify.)
  const sessionManager = new SessionManager({
    stateStore,
    workspaceRoot: runtime.workspace
  });
  const relayBridge = new RelayBridge({
    routeFilePath: relayRouteFileFromStateFile(runtime.stateFilePath)
  });
  setRuntimeRelayBridge(relayBridge);
  relayBridge.setPathReadyHandler(async (endpoint) => {
    try {
      await sessionManager.bindRelayPeerTransport(endpoint);
    } catch {
      /* peer health / ask will surface */
    }
  });
  relayBridge.setPeerEndpointHandler(async (event) => {
    try {
      await sessionManager.bindRelayPeerTransportForRelayPresence(event);
    } catch {
      /* peer health / ask will surface */
    }
  });
  const controlToken = generateControlToken();
  const controlPlane = new ControlPlane({
    sessionManager,
    workspace: runtime.workspace,
    relayBridge
  });
  const controlServer = await startControlHttpServer({
    controlPlane,
    controlToken
  });

  sessionManager.attachOwnerPresence(
    new OwnerPresence({
      controlBaseUrl: controlServer.baseUrl,
      controlToken,
      mintExchangeCode: () => controlServer.mintExchangeCode()
    })
  );

  const agent = createPairMeshA2AAgent(
    {
      name: runtime.agentName,
      host: runtime.host,
      port: runtime.port
    },
    {
      actionService: sessionManager.getActionService(),
      stateStore
    }
  );

  const runtimeMeta = computeRuntimeMetadata({
    bindHost: runtime.host,
    port: runtime.port,
    advertise: runtime.config.agent.advertise
  });

  const runtimeInfo: PairMeshRuntimeInfo = {
    pid: process.pid,
    port: runtime.port,
    baseUrl: runtimeMeta.baseUrl,
    bindHost: runtimeMeta.bindHost,
    advertisedUrl: runtimeMeta.advertisedUrl,
    agentName: runtime.agentName,
    projectId: runtime.config.projectId,
    startedAt: new Date().toISOString(),
    mode,
    controlUrl: controlServer.baseUrl,
    controlToken,
    ...(logFile ? { logFile } : {})
  };

  await writeRuntimeInfo(runtime.workspace, runtimeInfo);

    if (runtime.config.connectivity?.mode === "relay") {
    void restoreRelayAfterStart({
      sessionManager,
      relayBridge,
      localA2aBaseUrl: runtimeMeta.baseUrl,
      relayWsUrl: runtime.relayWsUrl
    });
  }

  let health;
  try {
    health = await fetchLocalHealth(runtimeMeta.baseUrl);
  } catch {
    health = null;
  }

  if (verbose) {
    console.log(`Agent: ${runtime.agentName}`);
    console.log(`Workspace: ${runtime.workspaceBasename}`);
    console.log(
      `Coding agent: ${runtime.codingAgentProvider === "cursor" ? "Cursor" : runtime.codingAgentProvider}`
    );
    console.log(`A2A: ${runtimeMeta.baseUrl}`);
    console.log(`Advertised: ${runtimeMeta.advertisedUrl}`);
    console.log(`Control: ${controlServer.baseUrl} (loopback; token in runtime.json)`);
    console.log("");
    printHealthLine(health);
    console.log("");
    console.log(`State: ${runtime.stateFilePath}`);
    console.log(`Config: ${runtime.configFilePath}`);
  }

  let deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
  let deferredRestartInFlight = false;

  const shutdown = async (): Promise<void> => {
    if (deferredRestartTimer) {
      clearInterval(deferredRestartTimer);
      deferredRestartTimer = null;
    }
    getReliabilityTracker().markStopped();
    setRuntimeRelayBridge(null);
    // Keep relay-route.json so the next start can re-attach without re-pairing.
    await relayBridge.stop({ clearPersisted: false });
    await controlServer.close();
    await agent.close();
    await clearRuntimeInfo(runtime.workspace);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

    // schedule a delayed `aroko start` and exit so the installed worker replaces us.
  if (mode === "background") {
    deferredRestartTimer = setInterval(() => {
      void (async () => {
        if (deferredRestartInFlight) return;
        try {
          const { PAIRMESH_BUILD_ID, readDeferredRestart, clearDeferredRestart } =
            await import("@pairmesh/client");
          const deferred = await readDeferredRestart(runtime.workspace);
          if (!deferred) return;
          if (deferred.targetBuildId === PAIRMESH_BUILD_ID) {
            await clearDeferredRestart(runtime.workspace);
            return;
          }
          const busy = await controlPlane.getRuntimeBusy();
          if (!busy.idle) return;
          deferredRestartInFlight = true;
          const { spawn } = await import("node:child_process");
          const { dirname, join } = await import("node:path");
          const { fileURLToPath } = await import("node:url");
          const runtimeDir = dirname(fileURLToPath(import.meta.url));
          const cliEntryCandidates = [
            join(runtimeDir, "..", "index.js"),
            join(runtimeDir, "..", "..", "dist", "index.js")
          ];
          const { existsSync } = await import("node:fs");
          const cliEntry = cliEntryCandidates.find((path) => existsSync(path));
          if (!cliEntry) {
            deferredRestartInFlight = false;
            return;
          }
          spawn(process.execPath, [cliEntry, "start"], {
            detached: true,
            stdio: "ignore",
            cwd: runtime.workspace,
            env: {
              ...process.env,
              PAIRMESH_PROJECT_ROOT: runtime.workspace,
              PAIRMESH_START_AFTER_MS: "2000"
            }
          }).unref();
          void shutdown();
        } catch {
          deferredRestartInFlight = false;
        }
      })();
    }, 5_000);
    deferredRestartTimer.unref?.();
  }

  await new Promise<void>(() => {
    // keep process alive
  });

  return { runtimeInfo, health };
}

async function restoreRelayAfterStart(input: {
  sessionManager: SessionManager;
  relayBridge: RelayBridge;
  localA2aBaseUrl: string;
  relayWsUrl?: string;
}): Promise<void> {
  try {
    const status = await input.sessionManager.getSessionStatus();
    if (status.status !== "active" || !status.security.authenticated) {
      return;
    }
    const restored = await input.relayBridge.restoreIfNeeded({
      sessionCode: status.sessionCode,
      localA2aBaseUrl: input.localA2aBaseUrl,
      relayWsUrl: input.relayWsUrl
    });
    if (!restored) {
      return;
    }
    await input.relayBridge.awaitRestoredReady(120_000);
    if (input.relayBridge.getStatus().role === "joiner") {
      const endpoint = input.relayBridge.getLocalEndpoint();
      if (endpoint) {
        await input.sessionManager.bindRelayPeerTransport(endpoint);
      }
    }
  } catch {
    // Doctor / ask will surface relay_unavailable; Stage 8 session remains valid.
  }
}

function printHealthLine(health: Awaited<ReturnType<typeof fetchLocalHealth>> | null): void {
  if (health?.readyForInspection) {
    console.log("Health: ready");
    return;
  }
  if (health?.status === "degraded") {
    console.log("Health: degraded");
    if (health.codingAgent?.reason) {
      console.log(`Reason: ${health.codingAgent.reason}`);
    }
    return;
  }
  console.log("Health: unavailable");
  if (health?.codingAgent?.reason) {
    console.log(`Reason: ${health.codingAgent.reason}`);
  }
}

export function formatHealthLabel(
  health: Awaited<ReturnType<typeof fetchLocalHealth>> | null | undefined
): string {
  if (health?.readyForInspection) {
    return "ready";
  }
  if (health?.status === "degraded") {
    return "degraded";
  }
  return "unavailable";
}
