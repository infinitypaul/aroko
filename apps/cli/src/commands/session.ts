import {
  applyResolvedLocalRuntimeToEnv,
  clearRelayRoute,
  ControlHttpClient,
  createJoinCommand,
  isLocalhostPeerUrl,
  preflightJoinPeer,
  relayRouteFileFromStateFile,
  requireActiveRuntime,
  resolveLocalRuntime,
  resolveRelayWsUrl,
  isRelayConnectivityMode,
  RuntimeNotRunningError,
  type PairMeshLocalConfig
} from "@pairmesh/client";
import { PairMeshErrorSchema } from "@pairmesh/protocol";
import { flagValue, requireFlag } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

function hasFlag(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

async function prepareWorkspace(flags: Record<string, string>): Promise<string> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace);
  const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
  applyResolvedLocalRuntimeToEnv(runtime);
  return workspace;
}

function controlClientFromActive(
  active: Awaited<ReturnType<typeof requireActiveRuntime>>
): ControlHttpClient {
  const controlUrl = active.runtimeInfo.controlUrl;
  const controlToken = active.runtimeInfo.controlToken;
  if (!controlUrl || !controlToken) {
    throw new Error(`Runtime Control API is not available. Restart with: ${cliBinaryLabel()} start`);
  }
  return new ControlHttpClient({ baseUrl: controlUrl, controlToken });
}

function isRelayMode(config: PairMeshLocalConfig): boolean {
  return isRelayConnectivityMode(config);
}

function requireRelayUrl(config: PairMeshLocalConfig): string {
  if (!isRelayMode(config)) {
    throw new Error("Relay mode is not enabled (connectivity.mode=relay).");
  }
  return resolveRelayWsUrl(config);
}

export async function runCreateCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await prepareWorkspace(flags);
  const active = await requireActiveRuntime(workspace);
  const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const status = await manager.createSession({
    name: flagValue(flags, "name") ?? active.runtimeInfo.agentName,
    agentUrl: active.peerUrl
  });

  const relayMode = isRelayMode(runtime.config);
  if (relayMode) {
    const relayWsUrl = requireRelayUrl(runtime.config);
    const control = controlClientFromActive(active);
    await control.startRelayCreator({
      relayWsUrl,
      sessionCode: status.sessionCode,
      inviteSecret: status.invite.inviteSecret
    });
  }

  const invite = createJoinCommand({
    sessionCode: status.sessionCode,
    ...(relayMode ? {} : { peerUrl: active.peerUrl }),
    inviteSecret: status.invite.inviteSecret
  });

  if (hasFlag(flags, "json")) {
    console.log(
      JSON.stringify(
        {
          sessionCode: status.sessionCode,
          sessionId: status.sessionId,
          peerUrl: invite.peerUrl,
          connectivityMode: runtime.config.connectivity?.mode ?? "direct-url",
          joinCommand: invite.joinCommand,
          inviteExpiresAt: status.invite.expiresAt,
          localhostOnly: invite.peerUrl ? isLocalhostPeerUrl(invite.peerUrl) : false
        },
        null,
        2
      )
    );
    return;
  }

  const bin = cliBinaryLabel();
  console.log("Collaboration created");
  console.log("");
  console.log(`Session: ${status.sessionCode}`);
  console.log(`Agent: ${status.localParticipant.agent.name}`);
  console.log(`Status: ${status.status}`);
  if (relayMode) {
    console.log("Connectivity: relay");
  }
  console.log("");
  console.log("Invite your teammate (single-use, expires " + status.invite.expiresAt + "):");
  console.log("");
  console.log(`  ${invite.joinCommand}`);
  console.log("");
  console.log(
    `Share this command over a channel you trust. The invite works once; run \`${bin} invite\` for a fresh one.`
  );
  if (invite.peerUrl && isLocalhostPeerUrl(invite.peerUrl)) {
    console.log("");
    console.log(
      "Note: this address is localhost-only. Another machine cannot join unless you configure agent.advertise and bind host explicitly."
    );
  }
}

export async function runJoinCommand(
  sessionCode: string,
  flags: Record<string, string>
): Promise<void> {
  const workspace = await prepareWorkspace(flags);
  let active;
  try {
    active = await requireActiveRuntime(workspace);
  } catch (error) {
    if (error instanceof RuntimeNotRunningError) {
      throw new Error(
        `Your Aroko runtime is not running.\n\nStart it:\n\n  ${cliBinaryLabel()} start`
      );
    }
    throw error;
  }

  const inviteSecret = requireFlag(flags, "invite");
  const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
  const relayMode = isRelayMode(runtime.config);
  let peerUrl = flagValue(flags, "peer");

  if (relayMode && !peerUrl) {
    const relayWsUrl = requireRelayUrl(runtime.config);
    const control = controlClientFromActive(active);
    const relay = await control.startRelayJoiner({
      relayWsUrl,
      sessionCode,
      inviteSecret
    });
    if (!relay.localEndpoint) {
      throw new Error("Relay joiner did not return a local endpoint.");
    }
    peerUrl = relay.localEndpoint;
  } else if (!peerUrl) {
    throw new Error(
      "Missing --peer. For internet join without a peer URL, use connectivity.mode=relay (hosted relay is automatic)."
    );
  } else {
    await preflightJoinPeer(peerUrl);
  }

  const manager = await createSessionManagerFromResolvedConfig(workspace);

  try {
    const status = await manager.joinSession({
      sessionCode,
      peerUrl,
      inviteSecret,
      name: flagValue(flags, "name") ?? active.runtimeInfo.agentName,
      agentUrl: flagValue(flags, "agent-url") ?? active.peerUrl
    });

    console.log("Joined collaboration");
    console.log("");
    console.log(`Session: ${status.sessionCode}`);
    console.log(`Status: ${status.status}`);
    if (relayMode) {
      console.log("Connectivity: relay");
    }
    console.log("");
    console.log("You");
    console.log(`  ${status.localParticipant.agent.name}`);
    console.log("");
    console.log("Peers");
    if (status.peers.length === 0) {
      console.log("  (none)");
    } else {
      for (const peer of status.peers) {
        console.log(`  ${peer.agent.name}`);
      }
    }
  } catch (error) {
    if (PairMeshErrorSchema.safeParse(error).success) {
      throw error;
    }
    if (error instanceof Error && /fetch failed/i.test(error.message)) {
      throw new Error(
        `Could not reach the creator over the relay tunnel (${error.message}).\n` +
          `Confirm the creator is still running and connectivity.relayUrl is reachable, then retry with a fresh invite.`
      );
    }
    throw error;
  }
}

export async function runInviteCommand(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, string>
): Promise<void> {
  if (subcommand === "list") {
    const workspace = await prepareWorkspace(flags);
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    const invites = await manager.listSessionInvites();
    if (hasFlag(flags, "json")) {
      console.log(JSON.stringify({ invites }, null, 2));
      return;
    }
    if (invites.length === 0) {
      console.log("No invites recorded.");
      return;
    }
    console.log("Invites (secrets never listed):");
    for (const invite of invites) {
      console.log(`  ${invite.invitationId}  ${invite.status}  expires ${invite.expiresAt}`);
    }
    return;
  }

  if (subcommand === "revoke") {
    const invitationId = positionals[0];
    if (!invitationId) {
      throw new Error(
        `Missing invitation id. Usage: ${cliBinaryLabel()} invite revoke <invitationId>`
      );
    }
    const workspace = await prepareWorkspace(flags);
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    await manager.revokeSessionInvite(invitationId);
    console.log(`Revoked invite ${invitationId}.`);
    return;
  }

  if (subcommand !== undefined) {
    const bin = cliBinaryLabel();
    throw new Error(
      `Unknown invite command. Usage: ${bin} invite | ${bin} invite list | ${bin} invite revoke <id>`
    );
  }

  const workspace = await prepareWorkspace(flags);
  const active = await requireActiveRuntime(workspace);
  const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const status = await manager.getSessionStatus();

  if (status.status !== "active") {
    throw new Error(`No active collaboration. Run: ${cliBinaryLabel()} create`);
  }

  const issued = await manager.createSessionInvite();
  const relayMode = isRelayMode(runtime.config);
  const invite = createJoinCommand({
    sessionCode: issued.sessionCode,
    ...(relayMode ? {} : { peerUrl: active.peerUrl }),
    inviteSecret: issued.inviteSecret
  });

  console.log(`Invite command (single-use, expires ${issued.expiresAt}):`);
  console.log("");
  console.log(`  ${invite.joinCommand}`);
  console.log("");
  if (issued.invitationId) {
    console.log(
      `Invitation id: ${issued.invitationId} (list/revoke without reprinting the secret)`
    );
    console.log("");
  }
  console.log(
    "This invite establishes a relationship with you only. Other open invites remain valid."
  );
  if (invite.peerUrl && isLocalhostPeerUrl(invite.peerUrl)) {
    console.log("");
    console.log("Note: this address is localhost-only for same-machine or local-network testing.");
  }
}

export async function runStatusCommand(flags: Record<string, string> = {}): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const status = await manager.getSessionStatus();
  const safePeers = await manager.listSafePeers();

  if (hasFlag(flags, "json")) {
    console.log(
      JSON.stringify(
        {
          sessionCode: status.sessionCode,
          status: status.status,
          security: status.security,
          local: {
            name: status.localParticipant.agent.name,
            participantId: status.localParticipant.participant.id,
            ...(status.localParticipant.serviceLabel
              ? { service: status.localParticipant.serviceLabel }
              : {})
          },
          peers: safePeers
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Session: ${status.sessionCode}`);
  console.log(`Status: ${status.status}`);
  console.log(
    `Security: ${
      status.security.authenticated
        ? `authenticated (${status.security.securityVersion})`
        : "re-pair required"
    }`
  );
  const localService = status.localParticipant.serviceLabel;
  console.log(
    `You: ${status.localParticipant.agent.name}${localService ? ` · ${localService}` : ""}`
  );
  console.log(`Open invites: ${status.security.openInvites}`);
  console.log("");

  let pendingCount = 0;
  let outboundCount = 0;
  try {
    pendingCount = (await manager.listPendingActions()).length;
    outboundCount = (await manager.listRequesterActions("awaiting_peer", 50)).length;
  } catch {
    /* session may lack action state */
  }
  if (pendingCount > 0 || outboundCount > 0) {
    console.log(
      `Requests: ${pendingCount} need your attention · ${outboundCount} waiting on peers`
    );
    if (pendingCount > 0) {
      const bin = cliBinaryLabel();
      console.log(`  Review: ${bin} requests   or   ${bin} open`);
    }
    console.log("");
  }

  const verbose = hasFlag(flags, "verbose") || hasFlag(flags, "debug");
  console.log("Peers");
  if (safePeers.length === 0) {
    console.log("  (none)");
  } else {
    for (const peer of safePeers) {
      const credential = status.security.activeCredentials.find(
        (entry) => entry.participantId === peer.participantId
      );
      const label = peer.service ? `${peer.displayName} · ${peer.service}` : peer.displayName;
      const trust =
        peer.relationship === "paired"
          ? verbose && credential
            ? `paired · credential ${credential.fingerprint}`
            : "paired"
          : peer.relationship;
      if (verbose) {
        console.log(`  ${label} · ${peer.participantId}`);
        console.log(`    trust: ${trust}`);
        console.log(`    connection: ${peer.connectivity}`);
      } else {
        console.log(`  ${label} · ${trust} · ${peer.connectivity}`);
      }
    }
  }

  if (!status.security.authenticated) {
    console.log("");
    console.log(
      `This session predates Aroko session authentication. Run \`${cliBinaryLabel()} leave\`, then create and join again.`
    );
  }
}

export async function runPeersCommand(flags: Record<string, string> = {}): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const peers = await manager.listSafePeers();

  if (hasFlag(flags, "json") || hasFlag(flags, "verbose")) {
    console.log(JSON.stringify({ peers }, null, 2));
    return;
  }

  if (peers.length === 0) {
    console.log("No peers in the active collaboration.");
    return;
  }

  const nameWidth = Math.max(4, ...peers.map((p) => p.displayName.length));
  const serviceWidth = Math.max(7, ...peers.map((p) => (p.service ?? "—").length));
  const trustWidth = Math.max(5, ...peers.map((p) => p.relationship.length));
  const connWidth = Math.max(10, ...peers.map((p) => p.connectivity.length));

  const header = [
    "NAME".padEnd(nameWidth),
    "SERVICE".padEnd(serviceWidth),
    "TRUST".padEnd(trustWidth),
    "CONNECTION".padEnd(connWidth)
  ].join("  ");
  console.log(header);
  for (const peer of peers) {
    console.log(
      [
        peer.displayName.padEnd(nameWidth),
        (peer.service ?? "—").padEnd(serviceWidth),
        peer.relationship.padEnd(trustWidth),
        peer.connectivity.padEnd(connWidth)
      ].join("  ")
    );
  }
}

export async function runPeerCommand(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, string>
): Promise<void> {
  if (subcommand === "pair") {
    const inviteSecret = requireFlag(flags, "invite");
    const peerUrl = requireFlag(flags, "peer-url");
    const workspace = await prepareWorkspace(flags);
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    const status = await manager.establishRelationship({
      peerUrl,
      inviteSecret
    });
    console.log(
      `Paired with peer via invite. Collaboration ${status.sessionCode} now has ${status.peers.length} peer(s).`
    );
    return;
  }

  if (subcommand !== "remove") {
    const bin = cliBinaryLabel();
    throw new Error(
      `Unknown peer command. Usage: ${bin} peer remove <ref> | ${bin} peer pair --invite <secret> --peer-url <url>`
    );
  }

  const peerRef = positionals[0];
  if (!peerRef) {
    throw new Error(
      `Missing peer ref. Usage: ${cliBinaryLabel()} peer remove <name|participantId|service>`
    );
  }

  const workspace = await prepareWorkspace(flags);
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const removed = await manager.removePeer(peerRef);

  console.log(`Revoked local relationship with ${removed.peer} (membership retained).`);
  console.log(
    `Revoked ${removed.revokedCredentials} session credential(s). That peer can no longer inspect this project.`
  );
}

export async function runLeaveCommand(flags: Record<string, string> = {}): Promise<void> {
  const workspace = await prepareWorkspace(flags);
  const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
  try {
    const active = await requireActiveRuntime(workspace);
    await controlClientFromActive(active).leave();
  } catch (error) {
    if (error instanceof RuntimeNotRunningError) {
      const manager = await createSessionManagerFromResolvedConfig(workspace);
      try {
        await manager.leaveSession();
      } catch {
        // No session — still drop stale relay attach credentials.
        await clearRelayRoute(relayRouteFileFromStateFile(runtime.stateFilePath));
      }
    } else {
      throw error;
    }
  }
  console.log("Left local collaboration.");
}

export async function runSendCommand(
  flags: Record<string, string>,
  message: string
): Promise<void> {
  const workspace = await prepareWorkspace(flags);
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const result = await manager.sendToPeer(requireFlag(flags, "peer"), message);
  console.log(result.responseText);
}
