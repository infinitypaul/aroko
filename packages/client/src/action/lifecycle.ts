import {
  canTransitionActionStatus,
  createPairMeshError,
  type ActionExecutionStatus
} from "@pairmesh/protocol";

export function assertActionTransition(
  from: ActionExecutionStatus,
  to: ActionExecutionStatus
): void {
  if (!canTransitionActionStatus(from, to)) {
    throw createPairMeshError({
      code: "pairmesh.action_invalid_transition",
      message: `Illegal action status transition: ${from} -> ${to}`,
      details: { from, to }
    });
  }
}

export function isTerminalActionStatus(status: ActionExecutionStatus): boolean {
  return (
    status === "completed" ||
    status === "denied" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "expired" ||
    status === "unknown_outcome" ||
    status === "partially_completed"
  );
}
