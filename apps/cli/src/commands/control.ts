import {
  ControlHttpClient,
  buildControlInboxUrl,
  openControlInboxInBrowser,
  readRuntimeInfo,
  requireActiveRuntime
} from "@pairmesh/client";
import { flagValue } from "../args.js";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";

export async function runControlCommand(
  flags: Record<string, string>,
  positionals: string[] = [],
  subcommand?: string
): Promise<void> {
  const action = subcommand ?? positionals[0] ?? "status";
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));

  if (action === "status") {
    await runControlStatus(workspace, flags);
    return;
  }

  if (action === "open") {
    await runControlOpen(workspace, flags);
    return;
  }

  throw new Error(
    `Unknown control command. Usage: ${cliBinaryLabel()} control status|open [--action <id>] [--view inbox|activity|history]`
  );
}

async function runControlStatus(workspace: string, flags: Record<string, string>): Promise<void> {
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace, { quiet: flags.json === "true" });

  const showToken = flags["show-token"] === "true";
  let runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo) {
    try {
      const active = await requireActiveRuntime(workspace);
      runtimeInfo = active.runtimeInfo;
    } catch {
      runtimeInfo = null;
    }
  }

  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    const bin = cliBinaryLabel();
    const product = productDisplayName();
    if (flags.json === "true") {
      console.log(
        JSON.stringify(
          {
            running: Boolean(runtimeInfo),
            control: null,
            message: `${product} runtime is not exposing a Control API. Run \`${bin} start\`.`
          },
          null,
          2
        )
      );
      return;
    }
    console.log(`Control API: not available (start ${product} first).`);
    return;
  }

  const client = new ControlHttpClient({
    baseUrl: runtimeInfo.controlUrl,
    controlToken: runtimeInfo.controlToken
  });
  const status = await client.getStatus();

  if (flags.json === "true") {
    console.log(
      JSON.stringify(
        {
          ...status,
          ...(showToken ? { controlToken: runtimeInfo.controlToken } : {})
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Control: ${runtimeInfo.controlUrl}`);
  console.log(`Version: ${status.version}${status.buildId ? ` (${status.buildId})` : ""}`);
  if (status.projectId) {
    console.log(`Project: ${status.projectId}`);
  }
  console.log(`Runtime: ${status.runtime.running ? "running" : "stopped"}`);
  if (status.runtime.a2aBaseUrl) {
    console.log(`A2A: ${status.runtime.a2aBaseUrl}`);
  }
  if (status.runtime.advertisedUrl) {
    console.log(`Advertised: ${status.runtime.advertisedUrl}`);
  }
  console.log(
    `Session: ${
      status.session.present
        ? `${status.session.sessionCode ?? "active"} (${status.session.peerCount} peers)`
        : "none"
    }`
  );
  if (status.reliability?.lastReconnect) {
    const r = status.reliability.lastReconnect;
    console.log(
      `Last reconnect: ${(r.durationMs / 1000).toFixed(1)}s${r.reason ? ` (${r.reason})` : ""}`
    );
  }
  if (status.reliability?.lastPeerRecovery) {
    console.log(
      `Last peer recovery: ${(status.reliability.lastPeerRecovery.durationMs / 1000).toFixed(1)}s`
    );
  }
  if (showToken) {
    console.log(`Control token: ${runtimeInfo.controlToken}`);
  }
}

async function runControlOpen(workspace: string, flags: Record<string, string>): Promise<void> {
  let runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo) {
    try {
      const active = await requireActiveRuntime(workspace);
      runtimeInfo = active.runtimeInfo;
    } catch {
      runtimeInfo = null;
    }
  }

  const bin = cliBinaryLabel();
  const product = productDisplayName();
  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    console.log(`${product} Inbox: not available (run \`${bin} start\` first).`);
    return;
  }

  const actionId = flagValue(flags, "action");
  const viewRaw = flagValue(flags, "view");
  const view =
    viewRaw === "inbox" || viewRaw === "activity" || viewRaw === "history" ? viewRaw : undefined;

  const client = new ControlHttpClient({
    baseUrl: runtimeInfo.controlUrl,
    controlToken: runtimeInfo.controlToken
  });
  const { code } = await client.mintExchangeCode();
  const inboxUrl = buildControlInboxUrl(runtimeInfo.controlUrl, code, {
    ...(actionId ? { actionId } : {}),
    ...(view ? { view } : {})
  });
  const opened = await openControlInboxInBrowser(inboxUrl);
  if (opened) {
    console.log(`Opened ${product} Inbox in your browser (loopback only).`);
    console.log(`Inbox: ${runtimeInfo.controlUrl}/control/web`);
    return;
  }
  console.log(`Open this URL in your browser (loopback only):`);
  console.log(`${runtimeInfo.controlUrl}/control/web`);
  console.log(`(Exchange code already minted — re-run \`${bin} control open\` if needed.)`);
}
