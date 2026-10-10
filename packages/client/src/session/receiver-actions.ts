import type { ActionExecutionRecord } from "@pairmesh/protocol";
import type { LocalSessionState } from "../session/schemas.js";
import { isTerminalActionStatus } from "../action/lifecycle.js";
import { toActionSafeView, type ActionSafeView } from "../action/session-bridge.js";

export type ReceiverActionListFilter = "pending" | "active" | "recent" | "all";

const IN_FLIGHT_STATUSES: ReadonlySet<ActionExecutionRecord["status"]> = new Set([
  "requested",
  "authenticating",
  "authorizing",
  "approved",
  "executing"
]);

export function listReceiverActionViews(
  state: LocalSessionState,
  filter: ReceiverActionListFilter,
  limit = 50
): ActionSafeView[] {
  const localId = state.localParticipant.participant.id;
  const executions = (state.actionExecutions ?? []).filter(
    (entry) => entry.targetParticipantId === localId
  );

  let filtered: ActionExecutionRecord[];
  switch (filter) {
    case "pending":
      filtered = executions.filter((entry) => entry.status === "approval_required");
      break;
    case "active":
      filtered = executions.filter((entry) => IN_FLIGHT_STATUSES.has(entry.status));
      break;
    case "recent":
      filtered = executions
        .filter((entry) => isTerminalActionStatus(entry.status))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 200));
      break;
    case "all":
      filtered = executions
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 200));
      break;
  }

  if (filter === "pending" || filter === "active") {
    filtered = [...filtered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  return filtered.map((execution) => toActionSafeView(state, execution));
}
