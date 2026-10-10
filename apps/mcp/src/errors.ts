import { PairMeshErrorSchema, type PairMeshError } from "@pairmesh/protocol";
import type { CallToolResult } from "@modelcontextprotocol/server";

export function isPairMeshError(error: unknown): error is PairMeshError {
  return PairMeshErrorSchema.safeParse(error).success;
}

export function toolSuccess(structured: unknown, summary: string): CallToolResult {
  const trimmedSummary = summary.trim();
  const content: CallToolResult["content"] = trimmedSummary
    ? [{ type: "text", text: summary }]
    : [];

  return {
    content,
    structuredContent: structured as Record<string, unknown>
  };
}

export function toolPairMeshError(error: PairMeshError): CallToolResult {
  const userMessage = toUserFacingErrorMessage(error);
  const structured = {
    layer: "pairmesh",
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    }
  };

  return {
    content: [{ type: "text", text: userMessage }],
    structuredContent: structured,
    isError: true
  };
}

function toUserFacingErrorMessage(error: PairMeshError): string {
  switch (error.code) {
    case "pairmesh.peer_unreachable":
      return "The peer's PairMesh agent is currently unreachable. Ensure the peer agent is running and try again.";
    case "pairmesh.connectivity_reconnecting":
      return "PairMesh is reconnecting the relay transport. Wait briefly and retry — do not re-pair or restart unless doctor stays failed.";
    case "pairmesh.relay_authentication_failed":
      return "Relay authentication failed. This is a connectivity credential problem, not a peer permission denial.";
    case "pairmesh.coding_agent_unavailable":
      return "The peer's coding agent is unavailable. The PairMesh agent may be reachable, but it cannot run inspections right now.";
    case "pairmesh.inspection_timeout":
      return "The inspection timed out while waiting for the peer's coding agent to finish.";
    case "pairmesh.inspection_cancelled":
      return "The inspection was cancelled.";
    case "pairmesh.inspection_not_found":
      return "No inspection execution was found for that request id.";
    case "pairmesh.approval_required":
      return (
        error.message ||
        "The peer must approve this capability locally before the request can run. Do not re-pair or run PairMesh setup."
      );
    case "pairmesh.capability_denied":
      return (
        error.message || "The peer has denied this PairMesh capability for the current session."
      );
    default:
      return `PairMesh error (${error.code}): ${error.message}`;
  }
}

export function toolA2AError(message: string): CallToolResult {
  const structured = {
    layer: "a2a",
    error: { message }
  };

  return {
    content: [{ type: "text", text: `A2A transport error: ${message}` }],
    structuredContent: structured,
    isError: true
  };
}

export async function runToolHandler<T>(
  handler: () => Promise<T>,
  toResult: (value: T) => CallToolResult
): Promise<CallToolResult> {
  try {
    return toResult(await handler());
  } catch (error) {
    if (isPairMeshError(error)) {
      return toolPairMeshError(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return toolA2AError(message);
  }
}
