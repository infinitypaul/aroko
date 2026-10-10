import type { ActionExecutionRecord } from "@pairmesh/protocol";
import { isTerminalActionStatus } from "../action/lifecycle.js";
import { toActionSafeView, type ActionSafeView } from "../action/session-bridge.js";
import type { LocalSessionState } from "../session/schemas.js";

export type RequesterActionListFilter = "active" | "recent" | "all" | "awaiting_peer";

/**
 * Outbound actions initiated by the local participant (requester view).
 */
export function listRequesterActionViews(
  state: LocalSessionState,
  filter: RequesterActionListFilter = "all",
  limit = 50
): ActionSafeView[] {
  const localId = state.localParticipant.participant.id;
  const executions = (state.actionExecutions ?? []).filter(
    (entry) => entry.requesterParticipantId === localId
  );

  let filtered: ActionExecutionRecord[];
  switch (filter) {
    case "awaiting_peer":
      filtered = executions.filter(
        (entry) =>
          entry.status === "approval_required" ||
          entry.status === "executing" ||
          entry.status === "requested" ||
          entry.status === "authorizing" ||
          entry.status === "approved"
      );
      break;
    case "active":
      filtered = executions.filter(
        (entry) => !isTerminalActionStatus(entry.status) || entry.status === "approval_required"
      );
      break;
    case "recent":
      filtered = executions
        .filter((entry) => isTerminalActionStatus(entry.status))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 200));
      break;
    case "all":
    default:
      filtered = executions
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 200));
      break;
  }

  if (filter === "awaiting_peer" || filter === "active") {
    filtered = [...filtered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  return filtered.map((execution) => toActionSafeView(state, execution));
}
