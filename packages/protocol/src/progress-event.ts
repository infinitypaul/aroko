import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";

export const ProgressVisibilitySchema = z.enum(["owner_only", "requester_safe", "local_admin"]);
export type ProgressVisibility = z.infer<typeof ProgressVisibilitySchema>;

/**
 * Coarse operational phases for actions (and reusable for inspection).
 * Additive — do not treat as a closed wire enum for peers yet.
 */
export const ProgressPhaseSchema = z.enum([
  "request_received",
  "authenticating",
  "authorizing",
  "provider_started",
  "investigating",
  "reading_searching",
  "proposal_preparing",
  "proposal_ready",
  "awaiting_owner_approval",
  "approved",
  "applying",
  "running_named_tests",
  "executing",
  "completed",
  "denied",
  "cancelled",
  "failed",
  "expired",
  "partially_completed",
  "unknown_outcome"
]);
export type ProgressPhase = z.infer<typeof ProgressPhaseSchema>;

export const ProgressActivityKindSchema = z.enum([
  "worker.started",
  "provider.message",
  "file.read",
  "search.started",
  "search.completed",
  "tool.started",
  "tool.in_progress",
  "tool.completed",
  "tool.failed",
  "command.started",
  "command.completed",
  "command.failed",
  "test.started",
  "test.completed",
  "finding",
  "proposal.preparing",
  "proposal.ready",
  "worker.completed",
  "worker.failed",
  "worker.cancelled"
]);
export type ProgressActivityKind = z.infer<typeof ProgressActivityKindSchema>;

/** Bounded toolStatus values for safeMetadata (provider-neutral). */
export const ProgressToolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ProgressToolStatus = z.infer<typeof ProgressToolStatusSchema>;

/** Approved safeMetadata keys only — unknown keys are stripped by sanitizeProgressSafeMetadata. */
export const PROGRESS_SAFE_METADATA_KEYS = [
  "relativePath",
  "toolName",
  "toolKind",
  "toolStatus",
  "query",
  "testProfile",
  "testName",
  "testSuite",
  "passed",
  "failed",
  "commandKind",
  "durationMs",
  "provider",
  "correlationId"
] as const;

export type ProgressSafeMetadataKey = (typeof PROGRESS_SAFE_METADATA_KEYS)[number];

const ProgressSafeMetadataObjectSchema = z.strictObject({
  relativePath: z.string().trim().min(1).max(500).optional(),
  toolName: z.string().trim().min(1).max(120).optional(),
  /** Provider-neutral tool category (e.g. search, read, execute) — not a dump field. */
  toolKind: z.string().trim().min(1).max(40).optional(),
  toolStatus: ProgressToolStatusSchema.optional(),
  /** Short sanitized search/query fragment — never raw prompts or secrets. */
  query: z.string().trim().min(1).max(200).optional(),
  testProfile: z.string().trim().min(1).max(120).optional(),
  testName: z.string().trim().min(1).max(160).optional(),
  testSuite: z.string().trim().min(1).max(160).optional(),
  /** Non-negative counts from provider-reported test summaries. */
  passed: z.number().int().nonnegative().max(1_000_000).optional(),
  failed: z.number().int().nonnegative().max(1_000_000).optional(),
  /** Semantic command category (e.g. shell, test) — never unrestricted argv/stdout. */
  commandKind: z.string().trim().min(1).max(40).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  provider: z.string().trim().min(1).max(80).optional(),
  correlationId: z.string().trim().min(1).max(120).optional()
});
export type ProgressSafeMetadata = z.infer<typeof ProgressSafeMetadataObjectSchema>;
export const ProgressSafeMetadataSchema = ProgressSafeMetadataObjectSchema.optional();

/**
 * Sensitive / forbidden metadata keys that must never appear on ProgressEvent.
 * Listed explicitly so tests can prove rejection (schema is also strictObject).
 */
export const PROGRESS_FORBIDDEN_METADATA_KEYS = [
  "chainOfThought",
  "reasoning",
  "thinking",
  "prompt",
  "rawPrompt",
  "stdout",
  "stderr",
  "commandOutput",
  "token",
  "apiKey",
  "secret",
  "authorization",
  "cookie",
  "absolutePath",
  "env",
  "environment"
] as const;

export const MAX_PROGRESS_EVENTS = 200;

function isSafeRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  if (value.includes("\0") || value.split(/[/\\]/).includes("..")) {
    return false;
  }
  return true;
}

function sanitizeStringField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code < 32 || code === 127 ? " " : char;
  }
  cleaned = cleaned.trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/**
 * Strip forbidden/unknown keys and normalize approved fields.
 * Returns undefined when nothing safe remains.
 */
export function sanitizeProgressSafeMetadata(
  input: Record<string, unknown> | ProgressSafeMetadata | undefined
): ProgressSafeMetadata | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const next: ProgressSafeMetadata = {};

  const relativePath = sanitizeStringField(raw.relativePath, 500);
  if (relativePath && isSafeRelativePath(relativePath)) {
    next.relativePath = relativePath;
  }

  const toolName = sanitizeStringField(raw.toolName, 120);
  if (toolName) {
    next.toolName = toolName;
  }

  const toolKind = sanitizeStringField(raw.toolKind, 40);
  if (toolKind) {
    next.toolKind = toolKind;
  }

  if (
    raw.toolStatus === "pending" ||
    raw.toolStatus === "in_progress" ||
    raw.toolStatus === "completed" ||
    raw.toolStatus === "failed"
  ) {
    next.toolStatus = raw.toolStatus;
  }

  const query = sanitizeStringField(raw.query, 200);
  if (query) {
    next.query = query;
  }

  const testProfile = sanitizeStringField(raw.testProfile, 120);
  if (testProfile) {
    next.testProfile = testProfile;
  }

  const testName = sanitizeStringField(raw.testName, 160);
  if (testName) {
    next.testName = testName;
  }

  const testSuite = sanitizeStringField(raw.testSuite, 160);
  if (testSuite) {
    next.testSuite = testSuite;
  }

  if (
    typeof raw.passed === "number" &&
    Number.isInteger(raw.passed) &&
    raw.passed >= 0 &&
    raw.passed <= 1_000_000
  ) {
    next.passed = raw.passed;
  }

  if (
    typeof raw.failed === "number" &&
    Number.isInteger(raw.failed) &&
    raw.failed >= 0 &&
    raw.failed <= 1_000_000
  ) {
    next.failed = raw.failed;
  }

  const commandKind = sanitizeStringField(raw.commandKind, 40);
  if (commandKind) {
    next.commandKind = commandKind;
  }

  if (
    typeof raw.durationMs === "number" &&
    Number.isInteger(raw.durationMs) &&
    raw.durationMs >= 0 &&
    raw.durationMs <= 86_400_000
  ) {
    next.durationMs = raw.durationMs;
  }

  const provider = sanitizeStringField(raw.provider, 80);
  if (provider) {
    next.provider = provider;
  }

  const correlationId = sanitizeStringField(raw.correlationId, 120);
  if (correlationId) {
    next.correlationId = correlationId;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/** Load-time migration: strip legacy/unknown safeMetadata keys before strict parse. */
function preprocessProgressEventInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const event = { ...(value as Record<string, unknown>) };
  if (!("safeMetadata" in event)) {
    return event;
  }
  const sanitized = sanitizeProgressSafeMetadata(
    event.safeMetadata as Record<string, unknown> | ProgressSafeMetadata | undefined
  );
  if (sanitized) {
    event.safeMetadata = sanitized;
  } else {
    delete event.safeMetadata;
  }
  return event;
}

export const ProgressEventSchema = z.preprocess(
  preprocessProgressEventInput,
  z.strictObject({
    operationId: z.string().trim().min(1).max(120),
    phase: ProgressPhaseSchema,
    visibility: ProgressVisibilitySchema,
    timestamp: IsoUtcTimestampSchema,
    /** Coarse safe label for UX — never CoT / raw tool dumps. */
    message: z.string().trim().min(1).max(500).optional(),
    /** Optional rich observable kind; omit for coarse lifecycle-only providers. */
    activityKind: ProgressActivityKindSchema.optional(),
    safeMetadata: ProgressSafeMetadataSchema,
    /** Monotonic append order within an operation (assigned on append when omitted). */
    sequence: z.number().int().nonnegative().max(1_000_000_000).optional(),
    /** Provider-native id for reconnect/replay dedupe. */
    providerEventId: z.string().trim().min(1).max(160).optional()
  })
);
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

/** File / search / tool / command detail — always owner_only; never requester-visible. */
export const OWNER_DETAIL_ACTIVITY_KINDS: ReadonlySet<ProgressActivityKind> = new Set([
  "file.read",
  "search.started",
  "search.completed",
  "tool.started",
  "tool.in_progress",
  "tool.completed",
  "tool.failed",
  "command.started",
  "command.completed",
  "command.failed"
]);

/** @deprecated Use OWNER_DETAIL_ACTIVITY_KINDS */
const OWNER_ONLY_ACTIVITY_KINDS = OWNER_DETAIL_ACTIVITY_KINDS;

/**
 * Default visibility when adapters omit an explicit value.
 * Owner-detail kinds are forced owner_only by resolveProgressVisibility regardless.
 */
export const DEFAULT_ACTIVITY_VISIBILITY: Readonly<
  Record<ProgressActivityKind, ProgressVisibility>
> = {
  "worker.started": "requester_safe",
  "provider.message": "requester_safe",
  "file.read": "owner_only",
  "search.started": "owner_only",
  "search.completed": "owner_only",
  "tool.started": "owner_only",
  "tool.in_progress": "owner_only",
  "tool.completed": "owner_only",
  "tool.failed": "owner_only",
  "command.started": "owner_only",
  "command.completed": "owner_only",
  "command.failed": "owner_only",
  "test.started": "requester_safe",
  "test.completed": "requester_safe",
  finding: "requester_safe",
  "proposal.preparing": "requester_safe",
  "proposal.ready": "requester_safe",
  "worker.completed": "requester_safe",
  "worker.failed": "requester_safe",
  "worker.cancelled": "requester_safe"
};

/**
 * Metadata keys that must never appear on requester-projected ProgressEvents
 * even if an event was (mis)tagged requester_safe.
 */
export const REQUESTER_FORBIDDEN_METADATA_KEYS = [
  "relativePath",
  "query",
  "toolName",
  "toolKind",
  "toolStatus",
  "commandKind",
  "testName",
  "testSuite"
] as const;

export function activityKindToProgressPhase(kind: ProgressActivityKind): ProgressPhase {
  switch (kind) {
    case "worker.started":
      return "provider_started";
    case "provider.message":
    case "finding":
      return "investigating";
    case "file.read":
    case "search.started":
    case "search.completed":
    case "tool.started":
    case "tool.in_progress":
    case "tool.completed":
    case "tool.failed":
    case "command.started":
    case "command.completed":
    case "command.failed":
      return "reading_searching";
    case "test.started":
    case "test.completed":
      return "running_named_tests";
    case "proposal.preparing":
      return "proposal_preparing";
    case "proposal.ready":
      return "proposal_ready";
    case "worker.completed":
      return "completed";
    case "worker.failed":
      return "failed";
    case "worker.cancelled":
      return "cancelled";
  }
}

/**
 * File/tool/search/command detail is always owner_only.
 * Other kinds honor an explicit visibility, else default from DEFAULT_ACTIVITY_VISIBILITY.
 */
export function resolveProgressVisibility(input: {
  activityKind?: ProgressActivityKind;
  visibility?: ProgressVisibility;
}): ProgressVisibility {
  if (input.activityKind && OWNER_ONLY_ACTIVITY_KINDS.has(input.activityKind)) {
    return "owner_only";
  }
  if (input.visibility) {
    return input.visibility;
  }
  if (input.activityKind) {
    return DEFAULT_ACTIVITY_VISIBILITY[input.activityKind];
  }
  return "owner_only";
}

/**
 * Adapter-level convention for lifecycle-scoped providerEventId values.
 *
 * Native provider ids alone are insufficient when one identity (e.g. Cursor toolCallId)
 * emits multiple semantic transitions (pending → in_progress → completed).
 * Adapters should build: [optionalPrefix:]nativeId:transition
 * Sequence remains Aroko's local order authority — providers need not supply it.
 */
export function buildLifecycleProviderEventId(input: {
  nativeId: string;
  transition: string;
  prefix?: string;
}): string {
  const native =
    sanitizeStringField(input.nativeId, 100) ??
    sanitizeStringField(String(input.nativeId ?? ""), 100);
  const transition =
    sanitizeStringField(input.transition, 40) ??
    sanitizeStringField(String(input.transition ?? ""), 40);
  if (!native || !transition) {
    return "unknown:event";
  }
  const combined = input.prefix
    ? `${sanitizeStringField(input.prefix, 40) ?? "provider"}:${native}:${transition}`
    : `${native}:${transition}`;
  return combined.length > 160 ? combined.slice(0, 160) : combined;
}

export function appendProgressEvent(
  existing: readonly ProgressEvent[] | undefined,
  event: ProgressEvent
): ProgressEvent[] {
  const prior = existing ?? [];

  if (event.providerEventId) {
    const duplicate = prior.some((entry) => entry.providerEventId === event.providerEventId);
    if (duplicate) {
      return prior.length <= MAX_PROGRESS_EVENTS
        ? [...prior]
        : prior.slice(prior.length - MAX_PROGRESS_EVENTS);
    }
  }

  const lastSequence = prior.reduce(
    (max, entry) => (typeof entry.sequence === "number" ? Math.max(max, entry.sequence) : max),
    -1
  );
  const sanitizedMeta = event.safeMetadata
    ? sanitizeProgressSafeMetadata(event.safeMetadata)
    : undefined;
  const withSequence: ProgressEvent = {
    ...event,
    sequence: event.sequence ?? lastSequence + 1,
    ...(sanitizedMeta ? { safeMetadata: sanitizedMeta } : {})
  };
  if (!sanitizedMeta && "safeMetadata" in withSequence) {
    delete (withSequence as { safeMetadata?: ProgressSafeMetadata }).safeMetadata;
  }

  const next = [...prior, withSequence];
  if (next.length <= MAX_PROGRESS_EVENTS) {
    return next;
  }
  return next.slice(next.length - MAX_PROGRESS_EVENTS);
}

function looksLikeOwnerDetailMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
    if (trimmed === "Inspecting relevant code." || trimmed === "Searching repository.") {
    return false;
  }
  if (/<<<PAIR_MESH_|<<<END_PAIR_MESH_/.test(trimmed)) {
    return true;
  }
  if (/^(Reading|Searching|Using)\b/i.test(trimmed)) {
    return true;
  }
  if (/\b(Reading|Searching)\s+\S+/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Strip owner-detail metadata and provider-internal fields from a requester view.
 * Returns undefined when nothing safe remains.
 */
export function sanitizeProgressSafeMetadataForRequester(
  input: ProgressSafeMetadata | undefined
): ProgressSafeMetadata | undefined {
  if (!input) {
    return undefined;
  }
  const next: NonNullable<ProgressSafeMetadata> = {};
  if (typeof input.testProfile === "string" && input.testProfile.trim()) {
    next.testProfile = input.testProfile.trim();
  }
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    next.durationMs = input.durationMs;
  }
  if (typeof input.passed === "number" && Number.isInteger(input.passed) && input.passed >= 0) {
    next.passed = input.passed;
  }
  if (typeof input.failed === "number" && Number.isInteger(input.failed) && input.failed >= 0) {
    next.failed = input.failed;
  }
  // relativePath / query / tool* / commandKind / testName / testSuite / provider / correlationId
  // never cross requester boundary
  return Object.keys(next).length > 0 ? next : undefined;
}

export function projectProgressEventForRequester(event: ProgressEvent): ProgressEvent | null {
  if (event.visibility !== "requester_safe") {
    return null;
  }
  if (event.activityKind && OWNER_DETAIL_ACTIVITY_KINDS.has(event.activityKind)) {
    return null;
  }

  const safeMetadata = sanitizeProgressSafeMetadataForRequester(event.safeMetadata);
  const message = sanitizeRequesterProgressMessage(event.message);

  const projected: ProgressEvent = {
    operationId: event.operationId,
    phase: event.phase,
    visibility: "requester_safe",
    timestamp: event.timestamp,
    ...(message ? { message } : {}),
    ...(event.activityKind ? { activityKind: event.activityKind } : {}),
    ...(safeMetadata ? { safeMetadata } : {}),
    ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {})
    // providerEventId intentionally omitted — provider-internal
  };

  // Drop empty husks (no message, no kind) unless they are terminal/lifecycle phases.
  if (
    !projected.message &&
    !projected.activityKind &&
    !["completed", "failed", "cancelled", "provider_started"].includes(projected.phase)
  ) {
    return null;
  }
  return projected;
}

export function sanitizeRequesterProgressMessage(message: string | undefined): string | undefined {
  if (typeof message !== "string" || !message.trim()) {
    return undefined;
  }
  // Strip C0 controls / DEL without a control-character regex (eslint no-control-regex).
  let text = [...message]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  if (looksLikeOwnerDetailMessage(text)) {
    return undefined;
  }
  if (
    /PRIVATE_COT|chain[\s_-]*of[\s_-]*thought/i.test(text) ||
    /Bearer\s+\S+/i.test(text) ||
    /\b(api[_-]?key|authorization|cookie|secret|password|token)\b\s*[:=]/i.test(text) ||
    /\.env\b/i.test(text)
  ) {
    return undefined;
  }
  // Redact absolute / home paths; if nothing useful remains after redact, drop.
  if (/\/Users\/|\/home\/|[A-Za-z]:[\\/]|~\/|\.\.\//.test(text)) {
    text = text
      .replace(/\/Users\/[^\s]+/g, "[path]")
      .replace(/\/home\/[^\s]+/g, "[path]")
      .replace(/[A-Za-z]:[\\/][^\s]+/g, "[path]")
      .replace(/~\/[^\s]+/g, "[path]")
      .replace(/\.\.\/[^\s]+/g, "[path]")
      .trim();
    if (!text || text === "[path]" || /^\[path\](\s+\[path\])*$/.test(text)) {
      return undefined;
    }
  }
  // Mid-flight progress never carries repo-relative paths (final InspectionResult
  // references remain gated by repository.source_references separately).
  if (
    /\b[\w.-]+(?:\/[\w.-]+){1,}\.(?:[A-Za-z0-9]{1,10})\b/.test(text) ||
    /`[^`\n]*\/[^`\n]+`/.test(text)
  ) {
    text = text
      .replace(/`[^`\n]*\/[^`\n]+`/g, "[path]")
      .replace(/\b[\w.-]+(?:\/[\w.-]+){1,}\.(?:[A-Za-z0-9]{1,10})\b/g, "[path]")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === "[path]" || /^\[path\]([,.\s]+\[path\])*$/.test(text)) {
      return undefined;
    }
  }
  return text.length > 500 ? text.slice(0, 500) : text;
}

export function projectInspectionProgressForRequester(
  events: readonly ProgressEvent[] | undefined,
  options?: { maxEvents?: number }
): ProgressEvent[] {
  if (!events?.length) {
    return [];
  }
  const maxEvents = Math.min(Math.max(options?.maxEvents ?? 32, 1), MAX_PROGRESS_EVENTS);
  const out: ProgressEvent[] = [];
  let sawCodeGeneric = false;
  let sawSearchGeneric = false;

  for (const event of events) {
    const projected = projectProgressEventForRequester(event);
    if (projected) {
      out.push(projected);
      continue;
    }

    const kind = event.activityKind;
    if (!kind || !OWNER_DETAIL_ACTIVITY_KINDS.has(kind)) {
      continue;
    }

    if (kind === "file.read" || kind.startsWith("tool.")) {
      if (sawCodeGeneric) {
        continue;
      }
      sawCodeGeneric = true;
      out.push({
        operationId: event.operationId,
        phase: "reading_searching",
        visibility: "requester_safe",
        timestamp: event.timestamp,
        message: "Inspecting relevant code.",
        ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {})
      });
      continue;
    }

    if (kind === "search.started" || kind === "search.completed") {
      if (sawSearchGeneric) {
        continue;
      }
      sawSearchGeneric = true;
      out.push({
        operationId: event.operationId,
        phase: "reading_searching",
        visibility: "requester_safe",
        timestamp: event.timestamp,
        message: "Searching repository.",
        ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {})
      });
    }
  }

  if (out.length <= maxEvents) {
    return out;
  }
  return out.slice(out.length - maxEvents);
}

/** Highest monotonic sequence in a progress list (defaults to -1). */
export function latestProgressSequence(events: readonly ProgressEvent[] | undefined): number {
  if (!events?.length) {
    return -1;
  }
  return events.reduce(
    (max, event) => (typeof event.sequence === "number" ? Math.max(max, event.sequence) : max),
    -1
  );
}

export function filterProgressEventsForViewer(
  events: readonly ProgressEvent[] | undefined,
  viewer: "owner" | "requester" | "local_admin"
): ProgressEvent[] {
  if (!events?.length) {
    return [];
  }
  if (viewer === "requester") {
    const out: ProgressEvent[] = [];
    for (const event of events) {
      const projected = projectProgressEventForRequester(event);
      if (projected) {
        out.push(projected);
      }
    }
    return out;
  }
  return [...events];
}

export function latestProgressEvent(
  events: readonly ProgressEvent[] | undefined
): ProgressEvent | undefined {
  if (!events?.length) {
    return undefined;
  }
  return events[events.length - 1];
}

/** Bounded tail for reconnect/replay (same hard retention bound). */
export function progressEventsForReplay(
  events: readonly ProgressEvent[] | undefined,
  limit: number = MAX_PROGRESS_EVENTS
): ProgressEvent[] {
  if (!events?.length) {
    return [];
  }
  const capped = Math.min(Math.max(limit, 0), MAX_PROGRESS_EVENTS);
  if (events.length <= capped) {
    return [...events];
  }
  return events.slice(events.length - capped);
}
