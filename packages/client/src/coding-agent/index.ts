import { loadLocalCodingAgentConfigFromEnv, toAdapterOptions } from "./config.js";
import { createCodingAgentAdapter } from "./registry.js";
import type { CodingAgentAdapter } from "./types.js";

export async function createCodingAgentAdapterFromEnv(): Promise<CodingAgentAdapter> {
  const config = await loadLocalCodingAgentConfigFromEnv();
  return createCodingAgentAdapter(config.provider, toAdapterOptions(config));
}

export {
  createCodingAgentAdapter,
  registerCodingAgentProvider,
  listRegisteredCodingAgentProviders,
  requireBuiltInProvider
} from "./registry.js";
export * from "./types.js";
export type { LocalCodingAgentConfig } from "./config.js";
export * from "./prompt.js";
export * from "./sanitize.js";
export * from "./source-references.js";
export * from "./descriptors.js";
export {
  CursorAcpAdapter,
  type CursorAcpAdapterOptions,
  type CursorAcpClient
} from "./cursor-adapter.js";
export {
  CursorAcpActivitySession,
  classifyCursorSessionUpdate,
  extractAgentMessageChunkText,
  extractSafeToolFieldsFromRawInput,
  isAgentThoughtChunk,
  parseCursorToolCall,
  parseCursorToolCallUpdate,
  CURSOR_TOOL_CORRELATION_MAX
} from "./cursor-acp-activity.js";
export { FakeCodingAgentAdapter } from "./fake-adapter.js";
export {
  GeminiCliAdapter,
  mapGeminiCliResult,
  mapGeminiCliStreamResult
} from "./gemini-cli-adapter.js";
export {
  ClaudeCodeAdapter,
  mapClaudeCodeResult,
  mapClaudeCodeStreamResult
} from "./claude-code-adapter.js";
export {
  dedupeClaudeActivityEvents,
  parseClaudeStreamJson,
  toWorkspaceRelativeToolPath,
  ClaudeStreamSession,
  mapClaudeStreamRecordToActivity
} from "./claude-stream-activity.js";
export {
  dedupeGeminiActivityEvents,
  mapGeminiStreamRecordToActivity,
  parseGeminiStreamJson,
  GeminiStreamSession
} from "./gemini-stream-activity.js";
export { NdjsonLineBuffer, NdjsonLineTooLongError } from "./ndjson-line-buffer.js";
export { runStreamingProcess, MAX_STREAM_CAPTURE_BYTES } from "./streaming-process.js";
export { LazyCodingAgentAdapter } from "./lazy-adapter.js";
export { probeCodingAgentAvailability } from "./availability.js";
export {
  CODING_AGENT_OWNER_VISIBILITY,
  ownerVisibilityForProvider,
  isRuntimeCapabilityEnabled,
  mayInstallReceiverSessionAwareness,
  type CodingAgentOwnerVisibilityCapabilities,
  type RuntimeCapabilityFlag,
  type ActiveSessionInboundPush,
  type PairMeshReceiverSessionIntegration,
  type ProviderActivityEvent,
  type ProviderActivityPhase,
  type ProviderActivityVisibility
} from "./provider-visibility.js";
export {
  parseProviderProposalResponse,
  providerProposalToUnifiedDiff,
  PROVIDER_PROPOSAL_FORMAT_V1,
  PROPOSAL_PROVIDER_BEGIN,
  PROPOSAL_PROVIDER_END
} from "./proposal-provider-response.js";
