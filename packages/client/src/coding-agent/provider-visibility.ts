
import type { ProgressActivityKind, ProgressSafeMetadata } from "@pairmesh/protocol";
import type { BuiltInCodingAgentProviderId } from "./types.js";

/** Observable provider lifecycle/tool activity (maps to ProgressEvent phases). */
export type ProviderActivityPhase =
  | "provider_started"
  | "investigating"
  | "reading_searching"
  | "proposal_preparing"
  | "proposal_ready"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export type ProviderActivityVisibility = "owner_only" | "requester_safe";

/**
 * Provider-neutral activity report. Prefer activityKind when the runtime
 * genuinely observes rich events; omit it for honest coarse degrade.
 * Never include chain-of-thought / reasoning fields.
 */
export interface ProviderActivityEvent {
  phase: ProviderActivityPhase;
    activityKind?: ProgressActivityKind;
  message?: string;
  safeMetadata?: ProgressSafeMetadata;
  visibility?: ProviderActivityVisibility;
  sequence?: number;
  providerEventId?: string;
}

/**
 * Runtime API capability: verified support, verified absence, or not yet verified.
 * Do not encode "PairMesh has not integrated yet" as false/none.
 */
export type RuntimeCapabilityFlag = true | false | "needs_verification";

export type ActiveSessionInboundPush =
  "none" | "hooks_and_mcp" | "experimental_channel" | "needs_verification";

/** Orthogonal to API capability — whether PairMesh ships the receiver-session path. */
export type PairMeshReceiverSessionIntegration =
  "shipped" | "not_shipped" | "investigation_required";

/**
 * Owner-visibility / session-integration capabilities per coding-agent provider.
 * Separate from execution capabilities (inspect/propose/cancel).
 */
export interface CodingAgentOwnerVisibilityCapabilities {
    headlessWorker: boolean;
  /** Coarse lifecycle boundaries during headless runs (provider started, preparing, complete). */
  headlessCoarseProgress: boolean;
  /**
   * Per-tool Read/Grep/search activity without CoT (only when provider API exposes it).
   * When false, PairMesh must not fabricate tool/file events.
   */
  headlessToolActivity: boolean;
  /** Hooks or equivalent can register an interactive session (runtime API). */
  activeSessionDiscovery: RuntimeCapabilityFlag;
  /** Runtime can host a receiver-local MCP client (list/show/open — never approve). */
  receiverMcpClient: RuntimeCapabilityFlag;
  /** How inbound Paul-requests can reach an active owner session (runtime API). */
  activeSessionInboundPush: ActiveSessionInboundPush;
  /** Fine-grained progress during interactive/ACP sessions (inspect path). */
  interactiveProgressStreaming: boolean;
  /** PairMesh product integration for receiver-session awareness (orthogonal to API). */
  pairmeshReceiverSessionIntegration: PairMeshReceiverSessionIntegration;
}

export const CODING_AGENT_OWNER_VISIBILITY: Record<
  BuiltInCodingAgentProviderId,
  CodingAgentOwnerVisibilityCapabilities
> = {
  /**
   * Cursor local Agent: sessionStart/sessionEnd + MCP client + MCP/tool hooks are
   * documented (cursor.com/docs/hooks). Cloud Agent lacks sessionStart/MCP hooks.
   * PairMesh receiver installer not shipped — graceful degrade to Inbox/notify.
   * Evidence: docs/stages/stage-16-cursor-session-integration-investigation.md
   */
  cursor: {
    headlessWorker: true,
    headlessCoarseProgress: true,
        headlessToolActivity: true,
    activeSessionDiscovery: true,
    receiverMcpClient: true,
    activeSessionInboundPush: "hooks_and_mcp",
    interactiveProgressStreaming: true,
    pairmeshReceiverSessionIntegration: "not_shipped"
  },
  "claude-code": {
    headlessWorker: true,
    headlessCoarseProgress: true,
        headlessToolActivity: true,
    activeSessionDiscovery: true,
    receiverMcpClient: true,
    activeSessionInboundPush: "hooks_and_mcp",
    interactiveProgressStreaming: false,
    pairmeshReceiverSessionIntegration: "shipped"
  },
  /**
   * Gemini CLI: SessionStart/End/BeforeAgent/AfterAgent + mcpServers documented.
   * Investigation complete; PairMesh installer deferred.
   * Evidence: docs/stages/stage-16-gemini-cli-session-integration-investigation.md
   */
  "gemini-cli": {
    headlessWorker: true,
    headlessCoarseProgress: true,
        headlessToolActivity: true,
    activeSessionDiscovery: true,
    receiverMcpClient: true,
    activeSessionInboundPush: "hooks_and_mcp",
    interactiveProgressStreaming: false,
    pairmeshReceiverSessionIntegration: "not_shipped"
  },
  fake: {
    headlessWorker: true,
    headlessCoarseProgress: true,
    headlessToolActivity: true,
    activeSessionDiscovery: false,
    receiverMcpClient: false,
    activeSessionInboundPush: "none",
    interactiveProgressStreaming: true,
    pairmeshReceiverSessionIntegration: "not_shipped"
  }
};

export function ownerVisibilityForProvider(
  providerId: BuiltInCodingAgentProviderId
): CodingAgentOwnerVisibilityCapabilities {
  return CODING_AGENT_OWNER_VISIBILITY[providerId];
}

/** True only when the runtime capability is verified present (not needs_verification). */
export function isRuntimeCapabilityEnabled(flag: RuntimeCapabilityFlag): boolean {
  return flag === true;
}

/**
 * Whether PairMesh may install receiver MCP/hooks for this provider today.
 * Requires verified API support + shipped (or explicitly allowed) PairMesh path.
 */
export function mayInstallReceiverSessionAwareness(
  visibility: CodingAgentOwnerVisibilityCapabilities
): boolean {
  return (
    isRuntimeCapabilityEnabled(visibility.receiverMcpClient) &&
    visibility.activeSessionInboundPush === "hooks_and_mcp" &&
    visibility.pairmeshReceiverSessionIntegration === "shipped"
  );
}
