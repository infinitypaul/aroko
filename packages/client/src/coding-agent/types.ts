import type { InspectionProgressEvent, PairMeshSourceReference } from "@pairmesh/protocol";
import type { SanitizedPriorTurn } from "./prompt.js";
import type {
  CodingAgentOwnerVisibilityCapabilities,
  ProviderActivityEvent
} from "./provider-visibility.js";

export const CODING_AGENT_ERROR_CODES = [
  "agent_unavailable",
  "agent_not_authenticated",
  "agent_timeout",
  "agent_permission_denied",
  "agent_execution_failed",
  "agent_misconfigured",
  "agent_busy",
  "agent_cancelled"
] as const;

export type CodingAgentErrorCode = (typeof CODING_AGENT_ERROR_CODES)[number];

export interface CodingAgentError {
  code: CodingAgentErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function createCodingAgentError(
  code: CodingAgentErrorCode,
  message: string,
  details?: Record<string, unknown>
): CodingAgentError {
  return { code, message, ...(details ? { details } : {}) };
}

export function isCodingAgentError(error: unknown): error is CodingAgentError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as CodingAgentError).code === "string" &&
    CODING_AGENT_ERROR_CODES.includes((error as CodingAgentError).code as CodingAgentErrorCode)
  );
}

/** Known built-in provider ids. Custom providers may use other strings via registry. */
export type BuiltInCodingAgentProviderId = "cursor" | "gemini-cli" | "claude-code" | "fake";

export type CodingAgentProviderId = BuiltInCodingAgentProviderId | (string & {});

export type CodingAgentAvailabilityStatus = "configured" | "available" | "unavailable" | "busy";

export interface CodingAgentProviderCapabilities {
  inspect: boolean;
  followUp: boolean;
  sourceReferences: boolean;
  cancellation: boolean;
  /** True when the provider can resume a native conversation across PairMesh turns. */
  nativeSessionResume: boolean;
    proposeChange: boolean;
}

export interface CodingAgentProviderDescriptor {
  id: CodingAgentProviderId;
  displayName: string;
  version?: string;
  capabilities: CodingAgentProviderCapabilities;
    ownerVisibility: CodingAgentOwnerVisibilityCapabilities;
}

export interface CodingAgentAvailability {
  provider: CodingAgentProviderId;
  configured: boolean;
  status: CodingAgentAvailabilityStatus;
  reason?: string;
}

/**
 * Local-only continuation hints for the receiving coding agent.
 * Never sent over A2A. PairMesh owns thread continuity; provider sessions are optional.
 */
export interface CodingAgentContinuation {
  /** Local provider session / process continuity handle (e.g. Cursor ACP session id). */
  providerSessionId?: string;
  /**
   * @deprecated Prefer `providerSessionId`. Retained for in-memory callers during migration.
   */
  cursorSessionId?: string;
  priorTurns?: SanitizedPriorTurn[];
  useNativeSessionResume?: boolean;
}

export interface CodingAgentRequest {
  question: string;
  requestId: string;
  threadId?: string;
  turnNumber?: number;
  continuation?: CodingAgentContinuation;
}

export type CodingAgentContinuityMode = "native_provider_session" | "sanitized_history_fallback";

export interface CodingAgentResult {
  summary: string;
  findings: string[];
  references: PairMeshSourceReference[];
  /** Local-only; never included in A2A responses. */
  providerSessionId?: string;
  /**
   * @deprecated Prefer `providerSessionId`.
   */
  cursorSessionId?: string;
  continuityMode?: CodingAgentContinuityMode;
}

export interface CodingAgentInspectOptions {
  onProgress?: (event: InspectionProgressEvent) => void;
    onProviderActivity?: (event: ProviderActivityEvent) => void;
  signal?: AbortSignal;
}

export interface CodingAgentProposeRequest {
  instruction: string;
  requestId: string;
  actionId?: string;
}

export interface CodingAgentProposeOptions {
  signal?: AbortSignal;
  onProviderActivity?: (event: ProviderActivityEvent) => void;
}

/**
 * Structured proposal output. Must not imply working-tree mutation.
 * PairMesh validates paths and stores an immutable artifact.
 */
export interface CodingAgentProposeResult {
  summary: string;
  unifiedDiff: string;
  providerMetadata?: Record<string, string | number | boolean | null>;
}

/**
 * Provider-neutral coding-agent contract.
 * Expresses what PairMesh needs — not Cursor ACP or Gemini CLI specifically.
 */
export interface CodingAgentAdapter {
  readonly provider: CodingAgentProviderDescriptor;

  getAvailability(): Promise<CodingAgentAvailability>;

  inspect(
    request: CodingAgentRequest,
    options?: CodingAgentInspectOptions
  ): Promise<CodingAgentResult>;

  /**
   * Optional proposal-only path. When absent or `capabilities.proposeChange` is
   * false, PairMesh returns `pairmesh.proposal_unsupported` — never enables writes.
   */
  proposeChange?(
    request: CodingAgentProposeRequest,
    options?: CodingAgentProposeOptions
  ): Promise<CodingAgentProposeResult>;
}

export interface CodingAgentAdapterOptions {
  workspace: string;
  mode: "ask" | "plan" | "agent";
  timeoutMs: number;
  /** Executable override (provider-specific; defaults applied by factory). */
  command?: string;
  /** Extra argv before provider defaults (provider-specific). */
  args?: string[];
}

export function resolveProviderSessionId(
  continuation: CodingAgentContinuation | undefined
): string | undefined {
  return continuation?.providerSessionId ?? continuation?.cursorSessionId;
}

export function resultProviderSessionId(result: CodingAgentResult): string | undefined {
  return result.providerSessionId ?? result.cursorSessionId;
}
