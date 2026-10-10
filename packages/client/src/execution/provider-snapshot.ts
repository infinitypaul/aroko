import { formatCodingAgentProviderDisplayName } from "../control/action-inbox.js";

/** Safe presentation identity captured at execution start — no secrets. */
export interface ExecutionProviderSnapshot {
  executionProviderId: string;
  executionProviderDisplayName: string;
}

export function buildExecutionProviderSnapshot(input: {
  providerId: string;
  displayName?: string;
}): ExecutionProviderSnapshot {
  const executionProviderId = input.providerId.trim();
  const executionProviderDisplayName =
    input.displayName?.trim() || formatCodingAgentProviderDisplayName(executionProviderId);
  return { executionProviderId, executionProviderDisplayName };
}

export function resolveStoredProviderDisplayName(input: {
  executionProviderDisplayName?: string;
  executionProviderId?: string;
}): string | undefined {
  if (
    typeof input.executionProviderDisplayName === "string" &&
    input.executionProviderDisplayName.trim()
  ) {
    return input.executionProviderDisplayName.trim();
  }
  if (typeof input.executionProviderId === "string" && input.executionProviderId.trim()) {
    return formatCodingAgentProviderDisplayName(input.executionProviderId.trim());
  }
  return undefined;
}
