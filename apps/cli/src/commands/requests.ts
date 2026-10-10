import { createInterface } from "node:readline";
import {
  ControlHttpClient,
  buildControlInboxUrl,
  enrichActionForControlInbox,
  formatPeerLabel,
  openControlInboxInBrowser,
  readRuntimeInfo,
  requireActiveRuntime
} from "@pairmesh/client";
import { flagValue } from "../args.js";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

/**
 * Everyday receiver (and requester read) path: list human-readable requests.
 * Prefer opening authenticated Inbox for approval — does not weaken Control authority.
 */
export async function runRequestsCommand(
  flags: Record<string, string>,
  positionals: string[] = []
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace, { quiet: flags.json === "true" });
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const sub = positionals[0];

  if (sub === "open" || flags.open === "true") {
    await openInbox(workspace);
    return;
  }

  const pending = await manager.listPendingActions();
  const outbound = await manager.listRequesterActions("awaiting_peer", 20);

  if (flags.json === "true") {
    console.log(JSON.stringify({ pending, outbound }, null, 2));
    return;
  }

  if (pending.length === 0 && outbound.length === 0) {
    const bin = cliBinaryLabel();
    console.log(`No ${productDisplayName()} requests right now.`);
    console.log(`Tip: ${bin} open  → local Inbox`);
    return;
  }

  if (pending.length > 0) {
    console.log("Needs your attention (receiver Inbox):");
    console.log("");
    pending.forEach((row, index) => {
      const enriched = enrichActionForControlInbox(row);
      const peer = row.peer ? formatPeerLabel(row.peer) : "Peer";
      const summary = enriched.requestSummary ?? enriched.actionLabel;
      console.log(`${index + 1}. ${peer} · ${summary}  ${humanStatus(row.status)}`);
    });
    console.log("");
  }

  if (outbound.length > 0) {
    console.log("Waiting on peers (your outbound requests):");
    console.log("");
    outbound.forEach((row, index) => {
      const peer = row.peer ? formatPeerLabel(row.peer) : "Peer";
      const summary = row.summary ?? row.actionType;
      console.log(
        `${pending.length + index + 1}. ${peer} · ${summary}  ${humanStatus(row.status)}`
      );
    });
    console.log("");
  }

  if (!process.stdin.isTTY) {
    console.log(`Open review: ${cliBinaryLabel()} open`);
    return;
  }

  console.log("Enter a number to open Inbox review, or press Enter to skip.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("> ", (value) => {
      rl.close();
      resolve(value.trim());
    });
  });
  if (!answer) {
    return;
  }
  const index = Number(answer);
  const combined = [...pending, ...outbound];
  if (!Number.isInteger(index) || index < 1 || index > combined.length) {
    console.log("Cancelled.");
    return;
  }
  const selected = combined[index - 1]!;
  await openInbox(workspace, selected.actionId);
}

function humanStatus(status: string): string {
  switch (status) {
    case "approval_required":
      return "Waiting for approval";
    case "executing":
      return "Investigating / working";
    case "completed":
      return "Completed";
    case "denied":
      return "Denied";
    case "failed":
      return "Failed";
    default:
      return status.replace(/_/g, " ");
  }
}

async function openInbox(workspace: string, actionId?: string): Promise<void> {
  const bin = cliBinaryLabel();
  const product = productDisplayName();
  let runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo) {
    try {
      runtimeInfo = (await requireActiveRuntime(workspace)).runtimeInfo;
    } catch {
      console.log(`${product} Inbox unavailable — run \`${bin} start\` first.`);
      return;
    }
  }
  if (!runtimeInfo.controlUrl || !runtimeInfo.controlToken) {
    console.log(`${product} Inbox unavailable — run \`${bin} start\` first.`);
    return;
  }
  const client = new ControlHttpClient({
    baseUrl: runtimeInfo.controlUrl,
    controlToken: runtimeInfo.controlToken
  });
  const { code } = await client.mintExchangeCode();
  const url = buildControlInboxUrl(runtimeInfo.controlUrl, code, {
    ...(actionId ? { actionId, view: "inbox" as const } : { view: "inbox" as const })
  });
  const opened = await openControlInboxInBrowser(url);
  console.log(
    opened
      ? `Opened local ${product} Inbox (Approve Once / Deny only there).`
      : `Open: ${runtimeInfo.controlUrl}/control/web`
  );
}
