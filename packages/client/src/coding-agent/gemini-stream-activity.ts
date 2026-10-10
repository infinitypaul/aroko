import {
  ProviderMessageAggregator,
  buildLifecycleProviderEventId,
  type ProgressActivityKind
} from "@pairmesh/protocol";
import type { ProviderActivityEvent } from "./provider-visibility.js";
import { toWorkspaceRelativeToolPath } from "./claude-stream-activity.js";
import { NdjsonLineBuffer, NdjsonLineTooLongError } from "./ndjson-line-buffer.js";
import { isPairMeshProtocolFramingText } from "./prompt.js";

export type GeminiStreamParseResult = {
  responseText: string;
  isError: boolean;
  errorMessage?: string;
  activity: ProviderActivityEvent[];
  hasRichToolActivity: boolean;
  sessionId?: string;
  model?: string;
};

/** Read-only tools PairMesh observes for activity (plan mode still applies at CLI). */
const ALLOWED_ACTIVITY_TOOLS = new Set([
  "read_file",
  "read_many_files",
  "grep_search",
  "glob",
  "list_directory"
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Map one Gemini NDJSON stream record into zero or more ProviderActivityEvents.
 */
export function mapGeminiStreamRecordToActivity(input: {
  record: unknown;
  workspace: string;
  requestId: string;
  pendingTools: Map<string, string>;
}): ProviderActivityEvent[] {
  const record = asRecord(input.record);
  if (!record) {
    return [];
  }

  const type = asString(record.type);
  if (!type) {
    return [];
  }

  // Never surface raw error payloads or unknown dumps as activity.
  if (type === "error") {
    return [];
  }

  // Assistant message narration is handled by GeminiStreamSession (aggregator), not here.
  if (type === "message") {
    return [];
  }

  if (type === "init") {
    return [
      {
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Gemini worker started.",
        visibility: "requester_safe",
        providerEventId: `${input.requestId}:gemini:init`,
        safeMetadata: {
          provider: "gemini-cli",
          correlationId: input.requestId
        }
      }
    ];
  }

  if (type === "tool_use") {
    const toolName = asString(record.tool_name);
    const toolId = asString(record.tool_id);
    if (!toolName || !toolId || !ALLOWED_ACTIVITY_TOOLS.has(toolName)) {
      return [];
    }
    input.pendingTools.set(toolId, toolName);
    const parameters = asRecord(record.parameters) ?? {};
    return mapGeminiToolUseToActivity({
      toolName,
      toolId,
      parameters,
      workspace: input.workspace,
      requestId: input.requestId
    });
  }

  if (type === "tool_result") {
    const toolId = asString(record.tool_id);
    if (!toolId) {
      return [];
    }
    const toolName = input.pendingTools.get(toolId);
    input.pendingTools.delete(toolId);
    if (!toolName || !ALLOWED_ACTIVITY_TOOLS.has(toolName)) {
      return [];
    }
    // Never include record.output (raw tool stdout) in activity.
    if (toolName === "grep_search" || toolName === "glob" || toolName === "list_directory") {
      return [
        {
          phase: "reading_searching",
          activityKind: "search.completed",
          message: "Search completed.",
          providerEventId: buildLifecycleProviderEventId({
            prefix: "gemini",
            nativeId: toolId,
            transition: "completed"
          }),
          safeMetadata: {
            toolName,
            provider: "gemini-cli",
            correlationId: input.requestId
          }
        }
      ];
    }
    // read_file / read_many_files: specialized file.read / tool.started already emitted.
    return [];
  }

  return [];
}

function mapGeminiToolUseToActivity(input: {
  toolName: string;
  toolId: string;
  parameters: Record<string, unknown>;
  workspace: string;
  requestId: string;
}): ProviderActivityEvent[] {
  const baseMeta = {
    toolName: input.toolName,
    provider: "gemini-cli" as const,
    correlationId: input.requestId
  };
  const id = buildLifecycleProviderEventId({
    prefix: "gemini",
    nativeId: input.toolId,
    transition: "started"
  });

  if (input.toolName === "read_file") {
    const relativePath = toWorkspaceRelativeToolPath(
      input.workspace,
      asString(input.parameters.file_path)
    );
    if (!relativePath) {
      return [
        {
          phase: "reading_searching",
          activityKind: "tool.started",
          message: "Reading repository file.",
          providerEventId: id,
          safeMetadata: baseMeta
        }
      ];
    }
    return [
      {
        phase: "reading_searching",
        activityKind: "file.read",
        message: `Reading ${relativePath}`,
        providerEventId: id,
        safeMetadata: { ...baseMeta, relativePath }
      }
    ];
  }

  if (input.toolName === "read_many_files") {
    return [
      {
        phase: "reading_searching",
        activityKind: "tool.started",
        message: "Reading workspace files.",
        providerEventId: id,
        safeMetadata: baseMeta
      }
    ];
  }

  if (input.toolName === "grep_search") {
    const query = asString(input.parameters.pattern);
    return [
      {
        phase: "reading_searching",
        activityKind: "search.started",
        message: query ? `Searching for ${query}` : "Searching workspace.",
        providerEventId: id,
        safeMetadata: {
          ...baseMeta,
          ...(query ? { query } : {})
        }
      }
    ];
  }

  if (input.toolName === "glob" || input.toolName === "list_directory") {
    const query =
      asString(input.parameters.pattern) ??
      asString(input.parameters.dir_path) ??
      asString(input.parameters.file_path);
    return [
      {
        phase: "reading_searching",
        activityKind: "search.started",
        message: query ? `Searching ${query}` : "Searching workspace.",
        providerEventId: id,
        safeMetadata: {
          ...baseMeta,
          ...(query ? { query } : {})
        }
      }
    ];
  }

  return [
    {
      phase: "reading_searching",
      activityKind: "tool.started" satisfies ProgressActivityKind,
      message: `${input.toolName} started.`,
      providerEventId: id,
      safeMetadata: baseMeta
    }
  ];
}

export function parseGeminiStreamJson(input: {
  stdout: string;
  workspace: string;
  requestId: string;
}): GeminiStreamParseResult {
  const trimmed = input.stdout.trim();
  if (!trimmed) {
    return {
      responseText: "",
      isError: true,
      errorMessage: "Gemini CLI returned empty output.",
      activity: [],
      hasRichToolActivity: false
    };
  }

  const session = new GeminiStreamSession({
    workspace: input.workspace,
    requestId: input.requestId
  });
  session.pushStdout(input.stdout.endsWith("\n") ? input.stdout : `${input.stdout}\n`);
  const finalized = session.finalize({ emitTrailingFragment: true });
  if (!finalized.responseText && !finalized.isError && !session.sawStructuredOutput) {
    return {
      responseText: trimmed,
      isError: false,
      activity: [],
      hasRichToolActivity: false
    };
  }
  return finalized;
}

export class GeminiStreamSession {
  private readonly workspace: string;
  private readonly requestId: string;
  private readonly onActivity?: (event: ProviderActivityEvent) => void;
  private readonly lineBuffer = new NdjsonLineBuffer();
  private readonly pendingTools = new Map<string, string>();
  private readonly seenActivityIds = new Set<string>();
  private readonly activity: ProviderActivityEvent[] = [];
  private readonly messages = new ProviderMessageAggregator();
  private messageSeq = 0;
  private thoughtRecordsSeen = 0;
  private responseText = "";
  private isError = false;
  private errorMessage: string | undefined;
  private sessionId: string | undefined;
  private model: string | undefined;
  private sawNdjson = false;
  private liveChunks = 0;
  private fenced = false;
  private lineOverflow: NdjsonLineTooLongError | undefined;
  private emittedLive = false;

  public constructor(input: {
    workspace: string;
    requestId: string;
    onActivity?: (event: ProviderActivityEvent) => void;
  }) {
    this.workspace = input.workspace;
    this.requestId = input.requestId;
    this.onActivity = input.onActivity;
  }

  public get sawStructuredOutput(): boolean {
    return this.sawNdjson || Boolean(this.responseText) || this.isError;
  }

  public fence(): void {
    this.fenced = true;
  }

  public get isFenced(): boolean {
    return this.fenced;
  }

  public get thoughtRecordCount(): number {
    return this.thoughtRecordsSeen;
  }

  public get receivedLiveChunks(): boolean {
    return this.liveChunks > 0;
  }

  public get didEmitLiveActivity(): boolean {
    return this.emittedLive;
  }

  public flushMessages(): void {
    if (this.fenced) {
      return;
    }
    const flush = this.messages.flush();
    if (flush?.text) {
      this.emitProviderMessage(flush.text, Boolean(this.onActivity));
    }
  }

  public pushStdout(chunk: string): void {
    if (this.fenced || !chunk) {
      return;
    }
    this.liveChunks += 1;
    let lines: string[];
    try {
      lines = this.lineBuffer.push(chunk);
    } catch (error) {
      if (error instanceof NdjsonLineTooLongError) {
        this.lineOverflow = error;
        this.fence();
        return;
      }
      throw error;
    }
    for (const line of lines) {
      this.ingestLine(line, Boolean(this.onActivity));
    }
  }

  public finalize(options?: { emitTrailingFragment?: boolean }): GeminiStreamParseResult {
    if (this.lineOverflow) {
      return {
        responseText: "",
        isError: true,
        errorMessage: this.lineOverflow.message,
        activity: dedupeGeminiActivityEvents(this.activity),
        hasRichToolActivity: this.computeHasRichToolActivity(),
        sessionId: this.sessionId,
        model: this.model
      };
    }

    if (options?.emitTrailingFragment !== false) {
      const trailing = this.lineBuffer.flush();
      if (trailing && !this.fenced) {
        this.ingestLine(trailing, Boolean(this.onActivity));
      }
    } else {
      this.lineBuffer.reset();
    }

    this.flushMessages();

    return {
      responseText: this.responseText,
      isError: this.isError,
      errorMessage: this.errorMessage,
      activity: dedupeGeminiActivityEvents(this.activity),
      hasRichToolActivity: this.computeHasRichToolActivity(),
      sessionId: this.sessionId,
      model: this.model
    };
  }

  public consumeBufferedStdout(stdout: string): GeminiStreamParseResult {
    if (this.emittedLive) {
      return this.finalize({ emitTrailingFragment: true });
    }
    this.lineBuffer.reset();
    this.liveChunks = 0;
    if (!stdout.trim()) {
      return {
        responseText: "",
        isError: true,
        errorMessage: "Gemini CLI returned empty output.",
        activity: [],
        hasRichToolActivity: false
      };
    }
    this.pushStdout(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
    return this.finalize({ emitTrailingFragment: true });
  }

  private computeHasRichToolActivity(): boolean {
    return this.activity.some(
      (event) =>
        event.activityKind === "file.read" ||
        event.activityKind === "search.started" ||
        event.activityKind === "search.completed" ||
        event.activityKind === "tool.started" ||
        event.activityKind === "tool.completed" ||
        event.activityKind === "tool.in_progress" ||
        event.activityKind === "tool.failed"
    );
  }

  private emitProviderMessage(text: string, emit: boolean): void {
    if (isPairMeshProtocolFramingText(text)) {
      return;
    }
    this.messageSeq += 1;
    this.acceptActivity(
      {
        phase: "investigating",
        activityKind: "provider.message",
        message: text,
        visibility: "requester_safe",
        providerEventId: buildLifecycleProviderEventId({
          prefix: "gemini",
          nativeId: `${this.requestId}:msg:${this.messageSeq}`,
          transition: "message"
        }),
        safeMetadata: {
          provider: "gemini-cli",
          correlationId: this.requestId
        }
      },
      emit
    );
  }

  private acceptActivity(event: ProviderActivityEvent, emit: boolean): void {
    if (this.fenced) {
      return;
    }
    const key = event.providerEventId;
    if (key) {
      if (this.seenActivityIds.has(key)) {
        return;
      }
      this.seenActivityIds.add(key);
    }
    this.activity.push(event);
    if (emit) {
      this.emittedLive = true;
      this.onActivity?.(event);
    }
  }

  private ingestLine(rawLine: string, emit: boolean): void {
    if (this.fenced) {
      return;
    }
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const record = asRecord(parsed);
    if (!record) {
      return;
    }

    // Legacy single-object without type.
    if (record.type === undefined) {
      if (record.error && typeof record.error === "object") {
        const err = asRecord(record.error);
        this.isError = true;
        this.errorMessage = asString(err?.message) ?? "Gemini CLI reported an error.";
        this.sessionId = asString(record.session_id) ?? this.sessionId;
        return;
      }
      if (typeof record.response === "string") {
        this.responseText = record.response;
        this.sessionId = asString(record.session_id) ?? this.sessionId;
        return;
      }
    }

    this.sawNdjson = true;
    if (!this.sessionId) {
      this.sessionId = asString(record.session_id);
    }
    if (!this.model && asString(record.type) === "init") {
      this.model = asString(record.model);
    }

    const type = asString(record.type);

    // Private reasoning / thought-like records: count only, never read content fields.
    if (
      type === "thinking" ||
      type === "reasoning" ||
      type === "thought" ||
      type === "chain_of_thought"
    ) {
      this.thoughtRecordsSeen += 1;
      return;
    }

    if (type === "tool_use") {
      this.flushMessages();
    }

    const mapped = mapGeminiStreamRecordToActivity({
      record: parsed,
      workspace: this.workspace,
      requestId: this.requestId,
      pendingTools: this.pendingTools
    });

    for (const event of mapped) {
      this.acceptActivity(event, emit);
    }

    if (type === "message" && asString(record.role) === "assistant") {
      const content = typeof record.content === "string" ? record.content : undefined;
      if (content && content.length > 0) {
        // Final-answer path (authoritative accumulation) — independent of aggregator.
        this.responseText += content;
        const flush = this.messages.push(content);
        if (flush?.text) {
          this.emitProviderMessage(flush.text, emit);
        }
      }
    }

    if (type === "result") {
      this.flushMessages();
      const status = asString(record.status);
      if (status === "error") {
        this.isError = true;
        const err = asRecord(record.error);
        this.errorMessage = asString(err?.message) ?? "Gemini CLI reported an error result.";
      }
      if (typeof record.response === "string" && record.response.trim()) {
        this.responseText = record.response;
      }
    }

    if (type === "error") {
      const msg = asString(record.message) ?? asString(asRecord(record.error)?.message);
      if (msg && /auth|api.?key|credential|login/i.test(msg)) {
        this.isError = true;
        this.errorMessage = msg;
      }
    }
  }
}

export function dedupeGeminiActivityEvents(
  events: readonly ProviderActivityEvent[]
): ProviderActivityEvent[] {
  const seen = new Set<string>();
  const out: ProviderActivityEvent[] = [];
  for (const event of events) {
    const key = event.providerEventId;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(event);
  }
  return out;
}
