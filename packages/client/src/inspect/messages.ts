import { formatLifecycleHumanMessage } from "../progress/activity-display.js";

export function formatInspectionWorkingMessage(peerName: string, requestId: string): string {
  return (
    `${formatLifecycleHumanMessage({ lifecycle: "running", peerLabel: peerName, requestId })} ` +
    `Continue with pairmesh_wait_for_inspection using that same requestId — do not start a new ask.`
  );
}

export function formatInspectionStillWorkingMessage(peerName: string, requestId: string): string {
  return formatLifecycleHumanMessage({
    lifecycle: "running",
    peerLabel: peerName,
    requestId
  });
}

/** Local wait budget expired while remote execution is still running (not a remote failure). */
export function formatInspectionWaitExpiredMessage(peerName: string, requestId: string): string {
  return formatLifecycleHumanMessage({
    lifecycle: "requester_wait_expired",
    peerLabel: peerName,
    requestId
  });
}

export function formatInspectionTransportUnavailableMessage(
  peerName: string,
  requestId: string
): string {
  return formatLifecycleHumanMessage({
    lifecycle: "peer_transport_unavailable",
    peerLabel: peerName,
    requestId
  });
}

export function formatInspectionDuplicateWorkingMessage(
  peerName: string,
  requestId: string
): string {
  return (
    `${formatInspectionWorkingMessage(peerName, requestId)} ` +
    `Returning the existing in-flight inspection instead of starting a duplicate.`
  );
}

export function formatInspectionCompletedText(input: {
  peerName: string;
  summary: string;
  findings?: string[];
  references?: Array<{
    file: string;
    symbol?: string;
    startLine?: number;
    endLine?: number;
  }>;
}): string {
  const findings =
    (input.findings?.length ?? 0) > 0 ? `\n\nFindings:\n- ${input.findings!.join("\n- ")}` : "";
  const references = formatReferencesForText(input.references ?? []);
  return `${input.peerName} found:\n${input.summary}${findings}${references}`;
}

function formatReferencesForText(
  references: Array<{
    file: string;
    symbol?: string;
    startLine?: number;
    endLine?: number;
  }>
): string {
  if (references.length === 0) {
    return "";
  }
  const lines = references.map((reference) => {
    const symbol = reference.symbol ? `\n  ${reference.symbol}` : "";
    const lines =
      reference.startLine && reference.endLine
        ? `\n  lines ${reference.startLine}-${reference.endLine}`
        : "";
    return `- ${reference.file}${symbol}${lines}`;
  });
  return `\n\nSource references:\n${lines.join("\n")}`;
}

/** Reject unsafe progress / MCP text that would leak internals. */
export function assertSafeInspectionUserText(text: string): void {
  const banned = [
    /\/Users\//i,
    /PAIRMESH_WORKSPACE/i,
    /PAIRMESH_STATE/i,
    /\.env\b/i,
    /"phase"\s*:/,
    /AgentEvent/i,
    /chain.of.thought/i
  ];
  for (const pattern of banned) {
    if (pattern.test(text)) {
      throw new Error(`Unsafe inspection user text matched ${pattern}`);
    }
  }
}
