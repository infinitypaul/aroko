import { flagValue } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

export async function runPermissionsCommand(
  flags: Record<string, string>,
  positionals: string[] = [],
  subcommand?: string
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const manager = await createSessionManagerFromResolvedConfig(workspace);
  const action = subcommand ?? positionals[0];
  const args = subcommand ? positionals : positionals.slice(1);
  const bin = cliBinaryLabel();

  if (!action || action === "list") {
    const peerFilter = flagValue(flags, "peer") ?? args[0];
    const rows = await manager.listPeerPermissions(peerFilter);
    if (flags.json === "true") {
      console.log(JSON.stringify({ peers: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No peers in the active session.");
      return;
    }
    for (const row of rows) {
      console.log(`Peer: ${row.peer}`);
      console.log("Capability                    Policy");
      for (const grant of row.grants) {
        console.log(`${grant.capabilityId.padEnd(30)} ${grant.policy}`);
      }
      console.log("");
    }
    return;
  }

  if (action === "pending") {
    const pending = await manager.listPendingPermissions();
    if (flags.json === "true") {
      console.log(JSON.stringify({ pending }, null, 2));
      return;
    }
    if (pending.length === 0) {
      console.log("No pending permission requests.");
      return;
    }
    for (const request of pending) {
      console.log(
        `${request.permissionRequestId}  ${request.capabilityId}  peer=${request.participantId}  request=${request.correlationRequestId}  expires=${request.expiresAt}`
      );
    }
    return;
  }

  if (action === "grant" || action === "revoke" || action === "require-approval") {
    const peerRef = args[0];
    const capabilityId = args[1];
    if (!peerRef || !capabilityId) {
      throw new Error(
        `Usage: ${bin} permissions ${action} <peer> <capability>\nExample: ${bin} permissions grant kelvin-agent repository.inspect`
      );
    }
    const policy =
      action === "grant" ? "allow_session" : action === "revoke" ? "deny" : "approval_required";
    const result = await manager.setPeerCapability(peerRef, capabilityId, policy);
    if (flags.json === "true") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${result.peer}: ${result.capabilityId} → ${result.policy}`);
    return;
  }

  if (action === "approve") {
    const permissionRequestId = args[0];
    if (!permissionRequestId) {
      throw new Error(
        `Usage: ${bin} permissions approve <permission-request-id> --once|--session`
      );
    }
    const once = flags.once === "true";
    const session = flags.session === "true";
    if (once === session) {
      throw new Error("Specify exactly one of --once or --session.");
    }
    const request = await manager.decidePendingPermission(
      permissionRequestId,
      once ? "allow-once" : "allow-session"
    );
    if (flags.json === "true") {
      console.log(JSON.stringify(request, null, 2));
      return;
    }
    console.log(
      `Approved ${request.permissionRequestId} (${once ? "allow-once" : "allow-session"}).`
    );
    return;
  }

  if (action === "deny") {
    const permissionRequestId = args[0];
    if (!permissionRequestId) {
      throw new Error(`Usage: ${bin} permissions deny <permission-request-id>`);
    }
    const request = await manager.decidePendingPermission(permissionRequestId, "deny");
    if (flags.json === "true") {
      console.log(JSON.stringify(request, null, 2));
      return;
    }
    console.log(`Denied ${request.permissionRequestId}.`);
    return;
  }

  throw new Error(
    [
      "Unknown permissions command.",
      "Usage:",
      `  ${bin} permissions [--peer <name>]`,
      `  ${bin} permissions pending`,
      `  ${bin} permissions grant <peer> <capability>`,
      `  ${bin} permissions revoke <peer> <capability>`,
      `  ${bin} permissions require-approval <peer> <capability>`,
      `  ${bin} permissions approve <permission-request-id> --once|--session`,
      `  ${bin} permissions deny <permission-request-id>`
    ].join("\n")
  );
}
