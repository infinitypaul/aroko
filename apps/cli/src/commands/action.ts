import { ArtifactIdSchema } from "@pairmesh/protocol";
import { flagValue, requireFlag } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

function actionUsage(): string {
  const bin = cliBinaryLabel();
  return [
    "Unknown action command.",
    "Usage:",
    `  ${bin} action pending [--json]`,
    `  ${bin} action list [--json]`,
    `  ${bin} action get <actionId> [--json]`,
    `  ${bin} action review <actionId> [--json]`,
    `  ${bin} action approve <actionId> --once|--session`,
    `  ${bin} action deny <actionId>`,
    `  ${bin} action wait <actionId> [--wait-ms N]`,
    `  ${bin} action cancel <actionId>`,
    `  ${bin} action propose --peer <peer> --instruction "..." [--json]`,
    `  ${bin} action apply --peer <peer> --artifact <id> --hash <sha256> [--json]`,
    `  ${bin} action test --peer <peer> --profile <name> [--json]`,
    "",
    "Receiver approve/deny are local admin (Control-token / CLI), same trust boundary as permissions.",
    `Prefer \`${bin} action approve\` for mutation approvals; \`permissions approve\` still bridges`,
    "action-linked permission rows when present. Prefer --once; --session is rejected when ActionService disallows it."
  ].join("\n");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runActionCommand(
  flags: Record<string, string>,
  positionals: string[] = [],
  subcommand?: string
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace, { quiet: flags.json === "true" });
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const action = subcommand ?? positionals[0];
  const args = subcommand ? positionals : positionals.slice(1);

  if (!action || action === "pending" || action === "list") {
    const pending = await manager.listPendingActions();
    if (flags.json === "true") {
      printJson({ actions: pending });
      return;
    }
    if (pending.length === 0) {
      console.log("No pending actions awaiting local approval.");
      return;
    }
    for (const row of pending) {
      const peer = row.peer?.displayName ?? row.requesterParticipantId;
      console.log(
        `${row.actionId}  ${row.actionType}  status=${row.status}  peer=${peer}` +
          (row.summary ? `  ${row.summary}` : "")
      );
    }
    return;
  }

  if (action === "get") {
    const actionId = args[0];
    if (!actionId) {
      throw new Error(`Usage: ${cliBinaryLabel()} action get <actionId> [--json]`);
    }
    const view = await manager.getAction(actionId);
    if (flags.json === "true") {
      printJson(view);
      return;
    }
    console.log(
      [
        `actionId: ${view.actionId}`,
        `type: ${view.actionType}`,
        `status: ${view.status}`,
        `capability: ${view.capabilityId}`,
        view.summary ? `summary: ${view.summary}` : undefined,
        view.message ? `message: ${view.message}` : undefined,
        view.permissionRequestId ? `permissionRequestId: ${view.permissionRequestId}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    );
    return;
  }

  if (action === "review") {
    const actionId = args[0];
    if (!actionId) {
      throw new Error(`Usage: ${cliBinaryLabel()} action review <actionId> [--json]`);
    }
    const proposal = await manager.reviewActionProposal(actionId);
    if (flags.json === "true") {
      printJson(proposal);
      return;
    }
    console.log(
      [
        `artifactId: ${proposal.artifactId}`,
        `contentHash: ${proposal.contentHash}`,
        `summary: ${proposal.summary}`,
        `files: ${proposal.affectedPaths.join(", ") || "(none)"}`,
        `stats: +${proposal.stats.additions}/-${proposal.stats.deletions} (${proposal.stats.filesChanged} file(s))`,
        "",
        proposal.unifiedDiff
      ].join("\n")
    );
    return;
  }

  if (action === "approve") {
    const actionId = args[0];
    if (!actionId) {
      throw new Error(`Usage: ${cliBinaryLabel()} action approve <actionId> --once|--session`);
    }
    const once = flags.once === "true";
    const session = flags.session === "true";
    if (once === session) {
      throw new Error(
        "Specify exactly one of --once or --session. Prefer --once; --session is rejected for repository.edit and other V1 types that disallow it."
      );
    }
    const view = await manager.approveAction(actionId, once ? "allow-once" : "allow-session");
    if (flags.json === "true") {
      printJson(view);
      return;
    }
    console.log(
      `Approved ${view.actionId} (${once ? "allow-once" : "allow-session"}) → status=${view.status}.`
    );
    return;
  }

  if (action === "deny") {
    const actionId = args[0];
    if (!actionId) {
      throw new Error(`Usage: ${cliBinaryLabel()} action deny <actionId>`);
    }
    const view = await manager.denyAction(actionId);
    if (flags.json === "true") {
      printJson(view);
      return;
    }
    console.log(`Denied ${view.actionId} → status=${view.status}.`);
    return;
  }

  if (action === "wait") {
    const actionId = args[0];
    if (!actionId) {
      throw new Error(`Usage: ${cliBinaryLabel()} action wait <actionId> [--wait-ms N]`);
    }
    const waitRaw = flagValue(flags, "wait-ms");
    const waitMs = waitRaw ? Number.parseInt(waitRaw, 10) : 30_000;
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw new Error("Invalid --wait-ms; expected a positive integer.");
    }
    const result = await manager.waitForAction(actionId, { waitMs });
    if (flags.json === "true") {
      printJson(result);
      return;
    }
    console.log(
      `actionId=${result.action.actionId} status=${result.action.status}` +
        (result.timedOut ? " (timed out; call wait again with the same actionId)" : "")
    );
    return;
  }

  if (action === "cancel") {
    const actionId = args[0];
    if (!actionId) {
      throw new Error(`Usage: ${cliBinaryLabel()} action cancel <actionId>`);
    }
    const local = await manager.getAction(actionId);
    const status = await manager.getSessionStatus();
    const view =
      local.targetParticipantId === status.localParticipant.participant.id
        ? await manager.cancelLocalAction(actionId)
        : await manager.cancelPeerAction(actionId);
    if (flags.json === "true") {
      printJson(view);
      return;
    }
    console.log(`Cancelled ${view.actionId} → status=${view.status}.`);
    return;
  }

  if (action === "propose") {
    const peer = requireFlag(flags, "peer");
    const instruction = requireFlag(flags, "instruction");
    const wire = await manager.requestPeerAction({
      peerRef: peer,
      actionType: "change.propose",
      parameters: { instruction }
    });
    if (flags.json === "true") {
      printJson(wire);
      return;
    }
    console.log(
      `Proposed change to ${peer}: actionId=${wire.actionId} status=${wire.status}` +
        (wire.summary ? ` — ${wire.summary}` : "")
    );
    return;
  }

  if (action === "apply") {
    const peer = requireFlag(flags, "peer");
    const artifactParsed = ArtifactIdSchema.safeParse(requireFlag(flags, "artifact"));
    if (!artifactParsed.success) {
      throw new Error("--artifact must be an Aroko artifact id (art_…).");
    }
    const contentHash = requireFlag(flags, "hash").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error("--hash must be a 64-character lowercase hex sha256 digest.");
    }
    const wire = await manager.requestPeerAction({
      peerRef: peer,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: artifactParsed.data,
        contentHash,
        artifactType: "patch_diff"
      }
    });
    if (flags.json === "true") {
      printJson(wire);
      return;
    }
    console.log(
      `Requested apply on ${peer}: actionId=${wire.actionId} status=${wire.status}` +
        (wire.status === "approval_required"
          ? ` — peer human must approve locally (prefer \`${cliBinaryLabel()} action approve\`).`
          : "")
    );
    return;
  }

  if (action === "test") {
    const peer = requireFlag(flags, "peer");
    const profile = requireFlag(flags, "profile");
    const wire = await manager.requestPeerAction({
      peerRef: peer,
      actionType: "tests.run",
      parameters: { profile }
    });
    if (flags.json === "true") {
      printJson(wire);
      return;
    }
    console.log(
      `Requested tests.run on ${peer} profile=${profile}: actionId=${wire.actionId} status=${wire.status}`
    );
    return;
  }

  throw new Error(actionUsage());
}
