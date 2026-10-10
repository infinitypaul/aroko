
import {
  ProviderMessageAggregator,
  buildLifecycleProviderEventId,
  sanitizeProgressSafeMetadata,
  type ProgressSafeMetadata
} from "@pairmesh/protocol";
import { toWorkspaceRelativeToolPath } from "./claude-stream-activity.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";
import { isPairMeshProtocolFramingText } from "./prompt.js";

export const CURSOR_TOOL_CORRELATION_MAX = 64;
export const CURSOR_PRIVATE_THOUGHT_SENTINEL = "PRIVATE_SENTINEL_DO_NOT_SURFACE";

type CursorToolKind = "search" | "read" | "other";
type CursorToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type CursorAcpSessionUpdateKind =
  | "agent_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "agent_thought_chunk"
  | "session_info_update"
  | "available_commands_update"
  | "unknown";

interface CursorToolCorrelation {
  toolCallId: string;
  kind: CursorToolKind;
  title?: string;
  relativePath?: string;
  query?: string;
  lastStatus?: CursorToolStatus;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex -- intentional control-char strip for titles
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

function classifyKind(raw: string | undefined): CursorToolKind {
  const kind = (raw ?? "").toLowerCase();
  if (kind === "search") {
    return "search";
  }
  if (kind === "read") {
    return "read";
  }
  return "other";
}

function classifyStatus(raw: string | undefined): CursorToolStatus | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Extract only allowlisted safe fields from Cursor tool rawInput.
 * Never returns/forwards the raw object.
 */
export function extractSafeToolFieldsFromRawInput(
  rawInput: unknown,
  workspace: string
): { relativePath?: string; query?: string } {
  const record = asRecord(rawInput);
  if (!record) {
    return {};
  }

  const pathCandidate =
    asString(record.path) ??
    asString(record.file_path) ??
    asString(record.filePath) ??
    asString(record.target_file) ??
    asString(record.uri);

  const relativePath = pathCandidate
    ? toWorkspaceRelativeToolPath(workspace, pathCandidate)
    : undefined;

  const query =
    asString(record.pattern) ??
    asString(record.query) ??
    asString(record.grep) ??
    asString(record.regex);

  const sanitized = sanitizeProgressSafeMetadata({
    ...(relativePath ? { relativePath } : {}),
    ...(query ? { query } : {})
  });

  return {
    ...(sanitized?.relativePath ? { relativePath: sanitized.relativePath } : {}),
    ...(sanitized?.query ? { query: sanitized.query } : {})
  };
}

export function classifyCursorSessionUpdate(params: unknown): CursorAcpSessionUpdateKind {
  const root = asRecord(params);
  const update = asRecord(root?.update) ?? root;
  const kind = asString(update?.sessionUpdate);
  switch (kind) {
    case "agent_message_chunk":
    case "tool_call":
    case "tool_call_update":
    case "agent_thought_chunk":
    case "session_info_update":
    case "available_commands_update":
      return kind;
    default:
      return "unknown";
  }
}

export function extractAgentMessageChunkText(params: unknown): string | undefined {
  if (classifyCursorSessionUpdate(params) !== "agent_message_chunk") {
    return undefined;
  }
  const root = asRecord(params);
  const update = asRecord(root?.update) ?? root;
  const content = asRecord(update?.content);
  return typeof content?.text === "string" && content.text.length > 0 ? content.text : undefined;
}

/**
 * Intentionally does not return thought text — only whether the event is a thought chunk.
 * Callers must not read content.text from thought updates.
 */
export function isAgentThoughtChunk(params: unknown): boolean {
  return classifyCursorSessionUpdate(params) === "agent_thought_chunk";
}

export function parseCursorToolCall(params: unknown):
  | {
      toolCallId: string;
      kind: CursorToolKind;
      status?: CursorToolStatus;
      title?: string;
      rawInput?: unknown;
    }
  | undefined {
  if (classifyCursorSessionUpdate(params) !== "tool_call") {
    return undefined;
  }
  const root = asRecord(params);
  const update = asRecord(root?.update) ?? root;
  const toolCallId = asString(update?.toolCallId);
  if (!toolCallId) {
    return undefined;
  }
  return {
    toolCallId,
    kind: classifyKind(asString(update?.kind)),
    status: classifyStatus(asString(update?.status)),
    title: boundTitle(asString(update?.title)),
    rawInput: update?.rawInput
  };
}

export function parseCursorToolCallUpdate(params: unknown):
  | {
      toolCallId: string;
      status: CursorToolStatus;
    }
  | undefined {
  if (classifyCursorSessionUpdate(params) !== "tool_call_update") {
    return undefined;
  }
  const root = asRecord(params);
  const update = asRecord(root?.update) ?? root;
  const toolCallId = asString(update?.toolCallId);
  const status = classifyStatus(asString(update?.status));
  if (!toolCallId || !status) {
    return undefined;
  }
  return { toolCallId, status };
}

export interface CursorAcpActivitySessionOptions {
  workspace: string;
  requestId: string;
  onActivity?: (event: ProviderActivityEvent) => void;
  /** Max correlated open/recent tool ids (default 64). */
  maxToolCorrelations?: number;
}

/**
 * Per-prompt ACP activity session.
 * Correlation state is intentionally not retained across unrelated inspect requests.
 */
export class CursorAcpActivitySession {
  private readonly workspace: string;
  private readonly requestId: string;
  private readonly onActivity?: (event: ProviderActivityEvent) => void;
  private readonly maxToolCorrelations: number;
  private readonly tools = new Map<string, CursorToolCorrelation>();
  private readonly emittedIds = new Set<string>();
  private readonly messages = new ProviderMessageAggregator();
  private messageSeq = 0;
  private fenced = false;
  private thoughtChunksSeen = 0;

  public constructor(options: CursorAcpActivitySessionOptions) {
    this.workspace = options.workspace;
    this.requestId = options.requestId;
    this.onActivity = options.onActivity;
    this.maxToolCorrelations = options.maxToolCorrelations ?? CURSOR_TOOL_CORRELATION_MAX;
  }

  public fence(): void {
    this.fenced = true;
  }

  public get isFenced(): boolean {
    return this.fenced;
  }

  public get thoughtChunkCount(): number {
    return this.thoughtChunksSeen;
  }

  public handleSessionUpdate(params: unknown): void {
    if (this.fenced) {
      return;
    }

    const kind = classifyCursorSessionUpdate(params);
    switch (kind) {
      case "agent_thought_chunk":
        // Do not touch content.text — count only.
        this.thoughtChunksSeen += 1;
        return;
      case "session_info_update":
      case "available_commands_update":
      case "unknown":
        return;
      case "agent_message_chunk": {
        const text = extractAgentMessageChunkText(params);
        if (!text) {
          return;
        }
        const flush = this.messages.push(text);
        if (flush?.text) {
          this.emitProviderMessage(flush.text);
        }
        return;
      }
      case "tool_call": {
        this.flushMessagesForToolBoundary();
        this.handleToolCall(params);
        return;
      }
      case "tool_call_update": {
        this.handleToolCallUpdate(params);
        return;
      }
      default:
        return;
    }
  }

  /** Flush remaining aggregated narration (end of turn / cancel policy: flush if safe). */
  public flushMessages(): void {
    if (this.fenced) {
      return;
    }
    const flush = this.messages.flush();
    if (flush?.text) {
      this.emitProviderMessage(flush.text);
    }
  }

  public clear(): void {
    this.tools.clear();
    this.emittedIds.clear();
    this.messages.reset();
  }

  private flushMessagesForToolBoundary(): void {
    const flush = this.messages.flush();
    if (flush?.text) {
      this.emitProviderMessage(flush.text);
    }
  }

  private emitProviderMessage(text: string): void {
    if (isPairMeshProtocolFramingText(text)) {
      return;
    }
    this.messageSeq += 1;
    this.emit({
      phase: "investigating",
      activityKind: "provider.message",
      message: text,
      visibility: "requester_safe",
      providerEventId: buildLifecycleProviderEventId({
        nativeId: `${this.requestId}:msg:${this.messageSeq}`,
        transition: "message",
        prefix: "cursor"
      }),
      safeMetadata: {
        provider: "cursor",
        correlationId: this.requestId
      }
    });
  }

  private handleToolCall(params: unknown): void {
    const parsed = parseCursorToolCall(params);
    if (!parsed) {
      return;
    }

    const safe = extractSafeToolFieldsFromRawInput(parsed.rawInput, this.workspace);
    const correlation: CursorToolCorrelation = {
      toolCallId: parsed.toolCallId,
      kind: parsed.kind,
      title: parsed.title,
      relativePath: safe.relativePath,
      query: safe.query,
      lastStatus: parsed.status ?? "pending"
    };
    this.rememberTool(correlation);

    const status = parsed.status ?? "pending";
    this.emitForStatus(correlation, status);
  }

  private handleToolCallUpdate(params: unknown): void {
    const parsed = parseCursorToolCallUpdate(params);
    if (!parsed) {
      return;
    }

    let correlation = this.tools.get(parsed.toolCallId);
    if (!correlation) {
      // Missing start — emit only what we know (generic tool lifecycle).
      correlation = {
        toolCallId: parsed.toolCallId,
        kind: "other",
        lastStatus: parsed.status
      };
      this.rememberTool(correlation);
    } else {
      correlation.lastStatus = parsed.status;
    }

    this.emitForStatus(correlation, parsed.status);

    if (parsed.status === "completed" || parsed.status === "failed") {
      this.tools.delete(parsed.toolCallId);
    }
  }

  private emitForStatus(tool: CursorToolCorrelation, status: CursorToolStatus): void {
    if (tool.kind === "search") {
      if (status === "pending") {
        this.emitSearchStarted(tool);
      } else if (status === "completed") {
        this.emitSearchCompleted(tool);
      }
      // in_progress: no extra event — keeps owner timeline clean.
      return;
    }

    if (tool.kind === "read") {
      if (status === "pending" || status === "in_progress") {
        // Emit file.read once at first observation (pending preferred).
        this.emitFileRead(tool);
      }
      // No fabricated file-read completion event.
      return;
    }

    // Generic / unknown tool kinds.
    if (status === "pending") {
      this.emitGenericTool(tool, "tool.started", "pending", "Tool started.");
    } else if (status === "in_progress") {
      this.emitGenericTool(tool, "tool.in_progress", "in_progress", "Tool in progress.");
    } else if (status === "completed") {
      this.emitGenericTool(tool, "tool.completed", "completed", "Tool completed.");
    } else if (status === "failed") {
      this.emitGenericTool(tool, "tool.failed", "failed", "Tool failed.");
    }
  }

  private emitSearchStarted(tool: CursorToolCorrelation): void {
    const meta = this.baseMeta(tool, "search", "pending");
    this.emit({
      phase: "reading_searching",
      activityKind: "search.started",
      message: tool.query ? `Searching for ${tool.query}` : "Searching repository.",
      providerEventId: buildLifecycleProviderEventId({
        nativeId: tool.toolCallId,
        transition: "started",
        prefix: "cursor"
      }),
      safeMetadata: meta
    });
  }

  private emitSearchCompleted(tool: CursorToolCorrelation): void {
    const meta = this.baseMeta(tool, "search", "completed");
    this.emit({
      phase: "reading_searching",
      activityKind: "search.completed",
      message: "Search completed.",
      providerEventId: buildLifecycleProviderEventId({
        nativeId: tool.toolCallId,
        transition: "completed",
        prefix: "cursor"
      }),
      safeMetadata: meta
    });
  }

  private emitFileRead(tool: CursorToolCorrelation): void {
    const meta = this.baseMeta(tool, "read", tool.lastStatus ?? "pending");
    this.emit({
      phase: "reading_searching",
      activityKind: "file.read",
      message: tool.relativePath ? `Reading ${tool.relativePath}` : "Reading repository file.",
      providerEventId: buildLifecycleProviderEventId({
        nativeId: tool.toolCallId,
        transition: "started",
        prefix: "cursor"
      }),
      safeMetadata: meta
    });
  }

  private emitGenericTool(
    tool: CursorToolCorrelation,
    activityKind: "tool.started" | "tool.in_progress" | "tool.completed" | "tool.failed",
    toolStatus: CursorToolStatus,
    fallbackMessage: string
  ): void {
    const transition =
      toolStatus === "pending"
        ? "started"
        : toolStatus === "in_progress"
          ? "in_progress"
          : toolStatus === "failed"
            ? "failed"
            : "completed";
    this.emit({
      phase: "reading_searching",
      activityKind,
      message: tool.title ? (boundTitle(tool.title) ?? fallbackMessage) : fallbackMessage,
      providerEventId: buildLifecycleProviderEventId({
        nativeId: tool.toolCallId,
        transition,
        prefix: "cursor"
      }),
      safeMetadata: this.baseMeta(tool, "other", toolStatus)
    });
  }

  private baseMeta(
    tool: CursorToolCorrelation,
    toolKind: string,
    toolStatus: CursorToolStatus
  ): ProgressSafeMetadata {
    return (
      sanitizeProgressSafeMetadata({
        provider: "cursor",
        correlationId: this.requestId,
        toolKind,
        toolStatus,
        ...(tool.title ? { toolName: tool.title } : {}),
        ...(tool.relativePath ? { relativePath: tool.relativePath } : {}),
        ...(tool.query ? { query: tool.query } : {})
      }) ?? { provider: "cursor", correlationId: this.requestId }
    );
  }

  private rememberTool(tool: CursorToolCorrelation): void {
    if (this.tools.has(tool.toolCallId)) {
      this.tools.set(tool.toolCallId, tool);
      return;
    }
    if (this.tools.size >= this.maxToolCorrelations) {
      // Evict completed-ish entries first (those without lastStatus pending/in_progress),
      // else drop oldest insertion.
      for (const [id, entry] of this.tools) {
        if (entry.lastStatus === "completed" || entry.lastStatus === "failed") {
          this.tools.delete(id);
          break;
        }
      }
      if (this.tools.size >= this.maxToolCorrelations) {
        const oldest = this.tools.keys().next().value;
        if (oldest) {
          this.tools.delete(oldest);
        }
      }
    }
    this.tools.set(tool.toolCallId, tool);
  }

  private emit(event: ProviderActivityEvent): void {
    if (this.fenced) {
      return;
    }
    const id = event.providerEventId;
    if (id) {
      if (this.emittedIds.has(id)) {
        return;
      }
      this.emittedIds.add(id);
    }
    this.onActivity?.(event);
  }
}
