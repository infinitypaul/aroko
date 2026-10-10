import type { ActionSafeView } from "../action/session-bridge.js";
import { getActionTypeDefinition } from "../action/registry.js";
import {
  getBuiltinProviderDescriptor,
  isBuiltInCodingAgentProviderId
} from "../coding-agent/descriptors.js";
import { formatReceiverAgentActionProvenance } from "../collaboration/task-progress-present.js";

const ACTION_SHORT_LABELS: Record<string, string> = {
  "change.propose": "Change proposal",
  "repository.edit": "Apply change",
  "tests.run": "Run tests",
  "process.execute": "Run command",
  "pairmesh.test.noop": "Test action",
  "pairmesh.test.artifact_apply": "Test apply",
  "pairmesh.test.run_profile": "Test profile run"
};

export interface ControlActionInboxView extends ActionSafeView {
  actionLabel: string;
  providerDisplayName?: string;
  requestSummary?: string;
  needsApproval: boolean;
  canApproveOnce: boolean;
  canApproveSession: boolean;
  /** R4-M1 — set when process.execute cannot be approved without displayable details. */
  approvalUnavailableReason?: string;
  /** R5-7 — CollaborativeTask id when Action is task-linked. */
  taskId?: string;
  originProvenance?: string;
  collaborativeProvenanceLabel?: string;
  /** Owner Action approval — never "answer" (requester InputRequest semantics). */
  collaborativeInteraction?: "approve";
}

export function enrichActionForControlInbox(
  view: ActionSafeView,
  options?: { codingAgentProviderId?: string }
): ControlActionInboxView {
  const definition = getActionTypeDefinition(view.actionType);
  const actionLabel =
    ACTION_SHORT_LABELS[view.actionType] ??
    definition?.description ??
    humanizeActionType(view.actionType);
  const requestSummary = extractRequestSummary(view);
  const providerDisplayName = resolveProviderDisplayName(view, options?.codingAgentProviderId);
  const needsApproval = view.status === "approval_required";
  const processDisplayBlocked =
    view.actionType === "process.execute" &&
    needsApproval &&
    (view.processApprovalDisplayUnavailable === true || !view.processExecution);
  const canApproveOnce = Boolean(definition?.requiresApproval) && !processDisplayBlocked;

  const collaborativeProvenanceLabel = formatReceiverAgentActionProvenance({
    originProvenance: view.originProvenance,
    requesterDisplayName: view.peer?.displayName
  });

  return {
    ...view,
    actionLabel,
    ...(providerDisplayName ? { providerDisplayName } : {}),
    ...(requestSummary ? { requestSummary } : {}),
    needsApproval,
    canApproveOnce,
    canApproveSession: Boolean(definition?.allowSessionApproval),
    ...(processDisplayBlocked
      ? {
          approvalUnavailableReason: "Unable to display command details. Approval unavailable."
        }
      : {}),
    ...(view.taskId ? { taskId: view.taskId } : {}),
    ...(view.originProvenance ? { originProvenance: view.originProvenance } : {}),
    ...(collaborativeProvenanceLabel ? { collaborativeProvenanceLabel } : {}),
    ...(needsApproval && view.taskId ? { collaborativeInteraction: "approve" as const } : {})
  };
}

export function formatCodingAgentProviderDisplayName(providerId: string): string {
  if (isBuiltInCodingAgentProviderId(providerId)) {
    return getBuiltinProviderDescriptor(providerId).displayName;
  }
  return providerId;
}

function humanizeActionType(actionType: string): string {
  return actionType
    .replace(/^pairmesh\./, "")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractRequestSummary(view: ActionSafeView): string | undefined {
  if (view.processExecution?.commandDisplay?.trim()) {
    return view.processExecution.commandDisplay.trim().slice(0, 240);
  }
  if (view.summary?.trim()) {
    return view.summary.trim();
  }
  const outputs = view.outputs;
  if (outputs) {
    const instruction = outputs.instruction ?? outputs.question ?? outputs.prompt;
    if (typeof instruction === "string" && instruction.trim()) {
      return instruction.trim().slice(0, 240);
    }
    if (typeof outputs.commandDisplay === "string" && outputs.commandDisplay.trim()) {
      return outputs.commandDisplay.trim().slice(0, 240);
    }
  }
  return undefined;
}

function resolveProviderDisplayName(
  view: ActionSafeView,
  configuredProviderId?: string
): string | undefined {
  if (typeof view.providerDisplayName === "string" && view.providerDisplayName.trim()) {
    return view.providerDisplayName.trim();
  }
  if (typeof view.executionProviderId === "string" && view.executionProviderId.trim()) {
    return formatCodingAgentProviderDisplayName(view.executionProviderId.trim());
  }
  const outputs = view.outputs;
  if (outputs && typeof outputs.providerId === "string") {
    return formatCodingAgentProviderDisplayName(outputs.providerId);
  }

  if (configuredProviderId) {
    return formatCodingAgentProviderDisplayName(configuredProviderId);
  }

  return undefined;
}
