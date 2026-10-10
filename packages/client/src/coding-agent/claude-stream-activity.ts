import { relative, resolve, sep } from "node:path";
import {
  ProviderMessageAggregator,
  buildLifecycleProviderEventId,
  type ProgressActivityKind
} from "@pairmesh/protocol";
import type { ProviderActivityEvent } from "./provider-visibility.js";
import { isUnsafeRelativePath } from "./source-references.js";
import { NdjsonLineBuffer, NdjsonLineTooLongError } from "./ndjson-line-buffer.js";
import { isPairMeshProtocolFramingText } from "./prompt.js";

export type ClaudeStreamParseResult = {
  responseText: string;
  isError: boolean;
  errorMessage?: string;
  activity: ProviderActivityEvent[];
  /** True when at least one tool_use produced a rich activity event. */
  hasRichToolActivity: boolean;
  sessionId?: string;
};

const ALLOWED_ACTIVITY_TOOLS = new Set(["Read", "Grep", "Glob"]);

type ContentBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  text?: unknown;
  thinking?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Convert a Claude tool path (often absolute) into a workspace-relative path.
 * Returns undefined when outside the workspace or unsafe.
 */
export function toWorkspaceRelativeToolPath(
  workspace: string,
  filePath: string | undefined
): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const raw = filePath.trim();
  const root = resolve(workspace);
  let candidate = raw;
  if (!raw.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(raw)) {
    if (isUnsafeRelativePath(raw)) {
      return undefined;
    }
    candidate = resolve(root, raw);
  }
  const rel = relative(root, resolve(candidate));
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isUnsafeRelativePath(rel)) {
    return undefined;
  }
  return rel.split(sep).join("/");
}

function contentBlocks(message: unknown): ContentBlock[] {
  const record = asRecord(message);
  const content = record?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((entry): entry is ContentBlock => Boolean(asRecord(entry)));
}

function toolInputRecord(input: unknown): Record<string, unknown> {
  return asRecord(input) ?? {};
}

/**
 * Map one NDJSON stream record into zero or more ProviderActivityEvents.
 * Unknown / malformed records yield [].
 */
export function mapClaudeStreamRecordToActivity(input: {
  record: unknown;
  workspace: string;
  requestId: string;
  /** tool_use id → tool name for completing results */
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

  // Never surface thinking / partial text streams as activity.
  if (type === "stream_event" || type === "thinking" || type === "tool_progress") {
    return [];
  }

  if (type === "system" && asString(record.subtype) === "init") {
    return [
      {
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Claude worker started.",
        visibility: "requester_safe",
        providerEventId: `${input.requestId}:claude:system.init`,
        safeMetadata: {
          provider: "claude-code",
          correlationId: input.requestId
        }
      }
    ];
  }

  if (type === "assistant") {
    const events: ProviderActivityEvent[] = [];
    for (const block of contentBlocks(record.message)) {
      const blockType = asString(block.type);
      // Thinking content blocks: never surface (session may count only).
      if (blockType === "thinking" || block.thinking !== undefined) {
        continue;
      }
      if (blockType !== "tool_use") {
        continue;
      }
      const name = asString(block.name);
      const id = asString(block.id);
      if (!name || !id || !ALLOWED_ACTIVITY_TOOLS.has(name)) {
        continue;
      }
      input.pendingTools.set(id, name);
      const toolInput = toolInputRecord(block.input);
      events.push(
        ...mapToolUseToActivity({
          toolName: name,
          toolUseId: id,
          toolInput,
          workspace: input.workspace,
          requestId: input.requestId
        })
      );
    }
    return events;
  }

  if (type === "user") {
    const events: ProviderActivityEvent[] = [];
    for (const block of contentBlocks(record.message)) {
      if (asString(block.type) !== "tool_result") {
        continue;
      }
      const toolUseId = asString(block.tool_use_id);
      if (!toolUseId) {
        continue;
      }
      const toolName = input.pendingTools.get(toolUseId);
      input.pendingTools.delete(toolUseId);
      if (!toolName || !ALLOWED_ACTIVITY_TOOLS.has(toolName)) {
        continue;
      }
      // Specialized search completion only — Read already emitted file.read; no tool.completed spam.
      if (toolName === "Grep" || toolName === "Glob") {
        events.push({
          phase: "reading_searching",
          activityKind: "search.completed",
          message: toolName === "Grep" ? "Search completed." : "Glob completed.",
          providerEventId: buildLifecycleProviderEventId({
            prefix: "claude",
            nativeId: toolUseId,
            transition: "completed"
          }),
          safeMetadata: {
            toolName,
            provider: "claude-code",
            correlationId: input.requestId
          }
        });
      }
    }
    return events;
  }

  return [];
}

function mapToolUseToActivity(input: {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  workspace: string;
  requestId: string;
}): ProviderActivityEvent[] {
  const baseMeta = {
    toolName: input.toolName,
    provider: "claude-code" as const,
    correlationId: input.requestId
  };
  const id = buildLifecycleProviderEventId({
    prefix: "claude",
    nativeId: input.toolUseId,
    transition: "started"
  });

  if (input.toolName === "Read") {
    const relativePath = toWorkspaceRelativeToolPath(
      input.workspace,
      asString(input.toolInput.file_path)
    );
    if (!relativePath) {
      // Observable Read without a safe path → generic tool.started only.
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

  if (input.toolName === "Grep") {
    const query = asString(input.toolInput.pattern);
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

  if (input.toolName === "Glob") {
    const query = asString(input.toolInput.pattern);
    return [
      {
        phase: "reading_searching",
        activityKind: "search.started",
        message: query ? `Glob ${query}` : "Globbing workspace.",
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

export function parseClaudeStreamJson(input: {
  stdout: string;
  workspace: string;
  requestId: string;
}): ClaudeStreamParseResult {
  const trimmed = input.stdout.trim();
  if (!trimmed) {
    return {
      responseText: "",
      isError: true,
      errorMessage: "Claude Code returned empty output.",
      activity: [],
      hasRichToolActivity: false
    };
  }

  const session = new ClaudeStreamSession({
    workspace: input.workspace,
    requestId: input.requestId
  });
  session.pushStdout(input.stdout.endsWith("\n") ? input.stdout : `${input.stdout}\n`);
  const finalized = session.finalize({ emitTrailingFragment: true });
  if (!finalized.activity.length && !finalized.responseText && !finalized.isError) {
    // Non-JSON stdout — treat as raw text success candidate (legacy).
    return {
      responseText: trimmed,
      isError: false,
      activity: [],
      hasRichToolActivity: false
    };
  }
  if (
    !finalized.responseText &&
    !finalized.isError &&
    !finalized.activity.length &&
    !session.sawStructuredOutput
  ) {
    return {
      responseText: trimmed,
      isError: false,
      activity: [],
      hasRichToolActivity: false
    };
  }
  return finalized;
}

export class ClaudeStreamSession {
  private readonly workspace: string;
  private readonly requestId: string;
  private readonly onActivity?: (event: ProviderActivityEvent) => void;
  private readonly lineBuffer = new NdjsonLineBuffer();
  private readonly pendingTools = new Map<string, string>();
  private readonly seenActivityIds = new Set<string>();
  private readonly activity: ProviderActivityEvent[] = [];
  private readonly messages = new ProviderMessageAggregator();
  private messageSeq = 0;
  private thoughtBlocksSeen = 0;
  private responseText = "";
  private isError = false;
  private errorMessage: string | undefined;
  private sessionId: string | undefined;
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

  public get thoughtBlockCount(): number {
    return this.thoughtBlocksSeen;
  }

  public get receivedLiveChunks(): boolean {
    return this.liveChunks > 0;
  }

  public get didEmitLiveActivity(): boolean {
    return this.emittedLive;
  }

  /** Flush remaining narration (end of turn / tool boundary). */
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

  public finalize(options?: { emitTrailingFragment?: boolean }): ClaudeStreamParseResult {
    if (this.lineOverflow) {
      return {
        responseText: "",
        isError: true,
        errorMessage: this.lineOverflow.message,
        activity: dedupeClaudeActivityEvents(this.activity),
        hasRichToolActivity: this.computeHasRichToolActivity(),
        sessionId: this.sessionId
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

    if (!this.sawNdjson && !this.responseText && !this.isError) {
      return {
        responseText: "",
        isError: false,
        activity: dedupeClaudeActivityEvents(this.activity),
        hasRichToolActivity: false,
        sessionId: this.sessionId
      };
    }

    return {
      responseText: this.responseText,
      isError: this.isError,
      errorMessage: this.errorMessage,
      activity: dedupeClaudeActivityEvents(this.activity),
      hasRichToolActivity: this.computeHasRichToolActivity(),
      sessionId: this.sessionId
    };
  }

  /**
   * Buffered test runners: feed full stdout once and emit activity (no prior live chunks).
   */
  public consumeBufferedStdout(stdout: string): ClaudeStreamParseResult {
    if (this.emittedLive) {
      return this.finalize({ emitTrailingFragment: true });
    }
    this.lineBuffer.reset();
    this.liveChunks = 0;
    if (!stdout.trim()) {
      return {
        responseText: "",
        isError: true,
        errorMessage: "Claude Code returned empty output.",
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
          prefix: "claude",
          nativeId: `${this.requestId}:msg:${this.messageSeq}`,
          transition: "message"
        }),
        safeMetadata: {
          provider: "claude-code",
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

  private ingestAssistantNarration(message: unknown, emit: boolean): boolean {
    let sawToolUse = false;
    for (const block of contentBlocks(message)) {
      const blockType = asString(block.type);
      if (blockType === "thinking" || block.thinking !== undefined) {
        this.thoughtBlocksSeen += 1;
        continue;
      }
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : undefined;
        if (!text) {
          continue;
        }
        const flush = this.messages.push(text);
        if (flush?.text) {
          this.emitProviderMessage(flush.text, emit);
        }
        continue;
      }
      if (blockType === "tool_use") {
        sawToolUse = true;
      }
    }
    return sawToolUse;
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

    // Legacy single-object `{ result }` without type.
    if (record.type === undefined && typeof record.result === "string") {
      this.responseText = record.result;
      this.isError = record.is_error === true;
      if (this.isError) {
        this.errorMessage = asString(record.result) ?? "Claude Code reported an error.";
      }
      this.sessionId = asString(record.session_id) ?? this.sessionId;
      return;
    }

    this.sawNdjson = true;
    if (!this.sessionId) {
      this.sessionId = asString(record.session_id);
    }

    const type = asString(record.type);

    // Count-only for top-level thinking records — never touch content.
    if (type === "thinking") {
      this.thoughtBlocksSeen += 1;
      return;
    }

    if (type === "assistant") {
      const sawToolUse = this.ingestAssistantNarration(record.message, emit);
      if (sawToolUse) {
        this.flushMessages();
      }
    }

    const mapped = mapClaudeStreamRecordToActivity({
      record: parsed,
      workspace: this.workspace,
      requestId: this.requestId,
      pendingTools: this.pendingTools
    });

    for (const event of mapped) {
      this.acceptActivity(event, emit);
    }

    if (type === "result") {
      this.flushMessages();
      const subtype = asString(record.subtype);
      if (subtype === "success" || subtype === undefined) {
        if (typeof record.result === "string") {
          this.responseText = record.result;
        }
        if (record.is_error === true) {
          this.isError = true;
          this.errorMessage = asString(record.result) ?? "Claude Code reported an error result.";
        }
      } else if (subtype?.startsWith("error_")) {
        this.isError = true;
        const errors = Array.isArray(record.errors)
          ? record.errors.filter((e): e is string => typeof e === "string")
          : [];
        this.errorMessage = errors[0] ?? `Claude Code failed (${subtype}).`;
      }
    }
  }
}

/** Deduplicate activity by providerEventId while preserving order. */
export function dedupeClaudeActivityEvents(
  events: readonly ProviderActivityEvent[]
): ProviderActivityEvent[] {
  const seen = new Set<string>();
  const out: ProviderActivityEvent[] = [];
  for (const event of events) {
    const key = event.providerEventId;
    if (key) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    out.push(event);
  }
  return out;
}
