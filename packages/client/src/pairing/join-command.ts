export interface JoinCommandInput {
  sessionCode: string;
  /** Omit for relay-mode invites (join resolves SessionCode via rendezvous). */
  peerUrl?: string;
  /** Single-use invite secret. Omitted only when rendering redacted examples. */
  inviteSecret?: string;
}

export interface JoinCommandResult {
  sessionCode: string;
  peerUrl?: string;
  joinCommand: string;
}

export function createJoinCommand(input: JoinCommandInput): JoinCommandResult {
  const sessionCode = input.sessionCode.trim();
  const peerUrl = input.peerUrl?.trim();
  const inviteSecret = input.inviteSecret?.trim();
  const peerPart = peerUrl ? ` --peer ${peerUrl}` : "";
  const invitePart = inviteSecret ? ` --invite ${inviteSecret}` : "";
  return {
    sessionCode,
    peerUrl,
    joinCommand: `aroko join ${sessionCode}${peerPart}${invitePart}`
  };
}

export function formatJoinInvite(result: JoinCommandResult): string {
  return result.joinCommand;
}
