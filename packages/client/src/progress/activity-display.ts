
import type {
  ProgressActivityKind,
  ProgressEvent,
  ProgressPhase,
  ProgressSafeMetadata
} from "@pairmesh/protocol";

export type ActivityViewer = "owner" | "requester";

export type ActivityDisplayEmphasis = "started" | "progress" | "narration" | "terminal" | "waiting";

export interface ActivityDisplayItem {
  /** Stable key for watch append / dedupe identity (event identity, not label). */
  key: string;
  label: string;
  emphasis: ActivityDisplayEmphasis;
  /** True when this is provider narration (render as quoted speech when helpful). */
  narration: boolean;
  phase: ProgressPhase;
  activityKind?: ProgressActivityKind;
  timestamp: string;
  event: ProgressEvent;
}

const COARSE_INVESTIGATING_LABELS = new Set([
  "Investigating",
  "Reading / searching",
  "Working",
  "Executing",
  "Provider started"
]);

const GENERIC_SAFE_INSPECT = "Inspecting relevant code.";
const GENERIC_SAFE_SEARCH = "Searching repository.";

export function formatElapsedDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function progressEventDisplayKey(event: ProgressEvent): string {
  if (event.providerEventId) {
    return `id:${event.providerEventId}`;
  }
  if (typeof event.sequence === "number") {
    return `seq:${event.operationId}:${event.sequence}`;
  }
  return `fallback:${event.timestamp}:${event.phase}:${event.activityKind ?? ""}:${event.message ?? ""}`;
}

function trimMessage(message: string | undefined): string {
  return typeof message === "string" ? message.trim() : "";
}

function looksUnsafeForDisplay(text: string): boolean {
  return (
    /\/Users\/|\/home\/|[A-Za-z]:[\\/]|PRIVATE_COT|chain[\s_-]*of[\s_-]*thought/i.test(text) ||
    /\b(api[_-]?key|authorization|cookie|secret|password|token)\b\s*[:=]/i.test(text)
  );
}

function ownerMeta(event: ProgressEvent): ProgressSafeMetadata {
  return event.safeMetadata ?? {};
}

/**
 * Human label for one ProgressEvent.
 * Owner may show relative paths / queries / tool names from safeMetadata.
 * Requester must never recover owner-only detail — only use the projected message/kind.
 */
export function formatProgressActivityLabel(
  event: ProgressEvent,
  viewer: ActivityViewer = "owner"
): string {
  const kind = event.activityKind;
  const message = trimMessage(event.message);
  // durationMs / test counts are requester-safe when present; paths/queries/tools are owner-only.
  const ownerFields = viewer === "owner" ? ownerMeta(event) : {};
  const sharedMeta = event.safeMetadata ?? {};
  const meta = {
    ...ownerFields,
    ...(typeof sharedMeta.durationMs === "number" ? { durationMs: sharedMeta.durationMs } : {}),
    ...(typeof sharedMeta.passed === "number" ? { passed: sharedMeta.passed } : {}),
    ...(typeof sharedMeta.failed === "number" ? { failed: sharedMeta.failed } : {}),
    ...(typeof sharedMeta.testProfile === "string" ? { testProfile: sharedMeta.testProfile } : {})
  };

  if (viewer === "requester") {
    if (kind === "file.read" || kind?.startsWith("tool.")) {
      return message === GENERIC_SAFE_INSPECT || message === "Inspecting relevant code"
        ? GENERIC_SAFE_INSPECT
        : message && !looksUnsafeForDisplay(message) && !/^(Reading|Using)\b/i.test(message)
          ? message
          : GENERIC_SAFE_INSPECT;
    }
    if (kind === "search.started" || kind === "search.completed") {
      return message === GENERIC_SAFE_SEARCH || message === "Searching repository"
        ? GENERIC_SAFE_SEARCH
        : message && !looksUnsafeForDisplay(message) && !/^Searching\s+\S+/i.test(message)
          ? message
          : GENERIC_SAFE_SEARCH;
    }
  }

  switch (kind) {
    case "worker.started":
      return "Started";
    case "provider.message":
      if (
        message &&
        !looksUnsafeForDisplay(message) &&
        !/^(Reading|Searching|Using)\b/i.test(message)
      ) {
        return message;
      }
      return "Working…";
    case "file.read":
      return meta.relativePath
        ? `Reading ${meta.relativePath}…`
        : message && !looksUnsafeForDisplay(message)
          ? message.endsWith("…") || message.endsWith("...")
            ? message
            : `${message.replace(/\.$/, "")}…`
          : "Reading file…";
    case "search.started":
      if (viewer === "owner" && meta.query) {
        return `Searching ${meta.query}…`;
      }
      return message === GENERIC_SAFE_SEARCH || !message
        ? "Searching repository…"
        : message.endsWith("…") || message.endsWith("...")
          ? message
          : `${message.replace(/\.$/, "")}…`;
    case "search.completed":
      return "Search complete";
    case "tool.started":
      return meta.toolName ? `Using ${meta.toolName}…` : message || "Using a tool…";
    case "tool.in_progress":
      return meta.toolName ? `${meta.toolName} in progress…` : message || "Tool in progress…";
    case "tool.completed":
      return meta.toolName ? `${meta.toolName} completed` : message || "Tool completed";
    case "tool.failed":
      return meta.toolName ? `${meta.toolName} failed` : message || "Tool failed";
    case "command.started":
      return message || "Running command…";
    case "command.completed":
      return message || "Command completed";
    case "command.failed":
      return message || "Command failed";
    case "test.started":
      return meta.testProfile ? `Running ${meta.testProfile}…` : message || "Running tests…";
    case "test.completed": {
      const passed = typeof meta.passed === "number" ? meta.passed : undefined;
      const failed = typeof meta.failed === "number" ? meta.failed : undefined;
      if (failed !== undefined && failed > 0) {
        return passed !== undefined
          ? `Tests failed (${passed} passed / ${failed} failed)`
          : `Tests failed (${failed} failed)`;
      }
      if (passed !== undefined) {
        return `${passed} tests passed`;
      }
      return message || "Tests passed";
    }
    case "finding":
      return message
        ? message.startsWith("Found")
          ? message
          : `Found: ${message}`
        : "Found a result";
    case "proposal.preparing":
      return "Preparing change…";
    case "proposal.ready":
      return "Waiting for approval";
    case "worker.completed": {
      const elapsed = formatElapsedDuration(meta.durationMs);
      if (elapsed) {
        return `Completed in ${elapsed}`;
      }
      return message.replace(/\.$/, "") || "Completed";
    }
    case "worker.failed": {
      const elapsed = formatElapsedDuration(meta.durationMs);
      if (elapsed) {
        return `Failed after ${elapsed}`;
      }
      return message.replace(/\.$/, "") || "Failed";
    }
    case "worker.cancelled": {
      const elapsed = formatElapsedDuration(meta.durationMs);
      if (elapsed) {
        return `Cancelled after ${elapsed}`;
      }
      return message.replace(/\.$/, "") || "Cancelled";
    }
    default:
      break;
  }

  if (message === GENERIC_SAFE_INSPECT || message === "Inspecting relevant code") {
    return GENERIC_SAFE_INSPECT;
  }
  if (message === GENERIC_SAFE_SEARCH || message === "Searching repository") {
    return GENERIC_SAFE_SEARCH;
  }

  return phaseFallbackLabel(event.phase, message);
}

function phaseFallbackLabel(phase: ProgressPhase | string | undefined, message: string): string {
  switch (phase) {
    case "request_received":
      return "Request delivered";
    case "authenticating":
      return "Connecting";
    case "authorizing":
      return "Authorizing";
    case "provider_started":
      return "Started";
    case "investigating":
    case "reading_searching":
      return "Investigating";
    case "proposal_preparing":
      return "Preparing change…";
    case "proposal_ready":
      return "Waiting for approval";
    case "awaiting_owner_approval":
      return "Waiting for approval";
    case "approved":
      return "Approved";
    case "applying":
      return "Applying change…";
    case "running_named_tests":
      return "Running tests…";
    case "executing":
      return "Working…";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    default:
      if (
        message &&
        !looksUnsafeForDisplay(message) &&
        !/^(Reading|Searching|Using)\b/i.test(message)
      ) {
        return message;
      }
      return phase ? String(phase).replace(/_/g, " ") : "Working…";
  }
}

function emphasisFor(event: ProgressEvent, label: string): ActivityDisplayEmphasis {
  const kind = event.activityKind;
  if (kind === "provider.message") {
    return "narration";
  }
  if (
    kind === "worker.completed" ||
    kind === "worker.failed" ||
    kind === "worker.cancelled" ||
    kind === "tool.failed" ||
    kind === "command.failed" ||
    event.phase === "completed" ||
    event.phase === "failed" ||
    event.phase === "cancelled" ||
    event.phase === "denied"
  ) {
    return "terminal";
  }
  if (
    kind === "worker.started" ||
    event.phase === "provider_started" ||
    event.phase === "request_received"
  ) {
    return "started";
  }
  if (
    kind === "proposal.ready" ||
    event.phase === "proposal_ready" ||
    event.phase === "awaiting_owner_approval"
  ) {
    return "waiting";
  }
  void label;
  return "progress";
}

function shouldAlwaysKeep(event: ProgressEvent): boolean {
  const kind = event.activityKind;
  return (
    kind === "worker.started" ||
    kind === "worker.completed" ||
    kind === "worker.failed" ||
    kind === "worker.cancelled" ||
    kind === "provider.message" ||
    kind === "finding" ||
    kind === "tool.failed" ||
    kind === "command.failed" ||
    kind === "proposal.ready" ||
    event.phase === "completed" ||
    event.phase === "failed" ||
    event.phase === "cancelled" ||
    event.phase === "denied" ||
    event.phase === "proposal_ready" ||
    event.phase === "awaiting_owner_approval"
  );
}

/**
 * Presentation-only noise suppression. Does not mutate persisted ProgressEvents.
 */
export function buildActivityDisplayItems(
  events: readonly ProgressEvent[] | undefined,
  viewer: ActivityViewer = "owner"
): ActivityDisplayItem[] {
  const list = Array.isArray(events) ? [...events] : [];
  list.sort((a, b) => {
    const sa = typeof a.sequence === "number" ? a.sequence : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.sequence === "number" ? b.sequence : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return String(a.timestamp).localeCompare(String(b.timestamp));
  });

  const seenKeys = new Set<string>();
  const out: ActivityDisplayItem[] = [];
  let lastLabel: string | undefined;
  let sawSearchStarted = false;
  let sawGenericInspect = false;
  let sawGenericSearch = false;
  const startedTools = new Set<string>();
  const readPaths = new Set<string>();

  for (const event of list) {
    const key = progressEventDisplayKey(event);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const kind = event.activityKind;
    const label = formatProgressActivityLabel(event, viewer);
    const always = shouldAlwaysKeep(event);

    if (!always) {
      if (kind === "search.completed" && sawSearchStarted) {
        continue;
      }
      if (kind === "tool.in_progress") {
        const tool = event.safeMetadata?.toolName ?? "";
        if (tool && startedTools.has(tool)) {
          continue;
        }
      }
      if (kind === "tool.completed") {
        const tool = event.safeMetadata?.toolName ?? "";
        if (tool && startedTools.has(tool)) {
          continue;
        }
      }
      if (kind === "file.read" && viewer === "owner") {
        const path = event.safeMetadata?.relativePath;
        if (path && readPaths.has(path)) {
          continue;
        }
        if (path) {
          readPaths.add(path);
        }
      }
      if (label === GENERIC_SAFE_INSPECT || label === "Inspecting relevant code") {
        if (sawGenericInspect) {
          continue;
        }
        sawGenericInspect = true;
      }
      if (
        label === GENERIC_SAFE_SEARCH ||
        label === "Searching repository…" ||
        label === "Searching repository."
      ) {
        if (sawGenericSearch && kind !== "search.started") {
          continue;
        }
        if (kind === "search.started" || !kind) {
          sawGenericSearch = true;
        }
      }
      if (COARSE_INVESTIGATING_LABELS.has(label) && lastLabel === label) {
        continue;
      }
      if (lastLabel === label && kind !== "provider.message") {
        continue;
      }
    }

    if (kind === "search.started") {
      sawSearchStarted = true;
      sawGenericSearch = true;
    }
    if (kind === "tool.started" && event.safeMetadata?.toolName) {
      startedTools.add(event.safeMetadata.toolName);
    }

    out.push({
      key,
      label,
      emphasis: emphasisFor(event, label),
      narration: kind === "provider.message",
      phase: event.phase,
      ...(kind ? { activityKind: kind } : {}),
      timestamp: event.timestamp,
      event
    });
    lastLabel = label;
  }

  return out;
}

export function activityDisplayMarker(
  item: ActivityDisplayItem,
  options?: { live?: boolean; isLast?: boolean }
): string {
  if (item.emphasis === "terminal") {
    if (/failed/i.test(item.label)) {
      return "✗";
    }
    if (/cancelled/i.test(item.label)) {
      return "○";
    }
    return "✓";
  }
  if (item.emphasis === "waiting") {
    return "○";
  }
  if (options?.live && options.isLast) {
    return "◐";
  }
  return "●";
}

export function formatActivityDisplayLine(
  item: ActivityDisplayItem,
  options?: { live?: boolean; isLast?: boolean; quoteNarration?: boolean }
): string {
  const marker = activityDisplayMarker(item, options);
  if (item.narration && options?.quoteNarration !== false) {
    const quoted = item.label.includes('"') ? item.label : `"${item.label}"`;
    return `${marker} ${quoted}`;
  }
  return `${marker} ${item.label}`;
}

export interface FormatActivityTimelineInput {
  progress: readonly ProgressEvent[] | undefined;
  viewer: ActivityViewer;
  header?: string;
  question?: string;
  providerDisplayName?: string;
  peerLabel?: string;
  status?: string;
  live?: boolean;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Full human timeline block for ask/watch/snapshots.
 * Does not include the final answer body — caller appends that separately.
 */
export function formatActivityTimelineText(input: FormatActivityTimelineInput): string {
  const items = buildActivityDisplayItems(input.progress, input.viewer);
  const lines: string[] = [];

  const header =
    input.header?.trim() ||
    [input.peerLabel?.trim(), input.providerDisplayName?.trim()].filter(Boolean).join(" — ");
  if (header) {
    lines.push(header);
  }

  if (input.question?.trim() && input.viewer === "owner") {
    if (lines.length) {
      lines.push("");
    }
    lines.push(`"${input.question.trim()}"`);
  }

  if (lines.length) {
    lines.push("");
  }

  if (!items.length) {
    const fallback =
      input.status === "approval_required"
        ? "○ Waiting for approval"
        : input.status === "failed"
          ? "✗ Failed"
          : input.status === "cancelled"
            ? "○ Cancelled"
            : input.status === "timed_out"
              ? "✗ Timed out"
              : "● Working…";
    lines.push(fallback);
    return lines.join("\n");
  }

  const enriched = items.map((item, index) => {
    const isLast = index === items.length - 1;
    if (
      isLast &&
      (item.activityKind === "worker.completed" || item.phase === "completed") &&
      !/Completed in /.test(item.label) &&
      input.startedAt
    ) {
      const end = input.completedAt ? Date.parse(input.completedAt) : Date.now();
      const start = Date.parse(input.startedAt);
      const elapsed = formatElapsedDuration(end - start);
      if (elapsed) {
        return { ...item, label: `Completed in ${elapsed}` };
      }
    }
    if (
      isLast &&
      (item.activityKind === "worker.failed" || item.phase === "failed") &&
      !/Failed after /.test(item.label) &&
      input.startedAt
    ) {
      const end = input.completedAt ? Date.parse(input.completedAt) : Date.now();
      const start = Date.parse(input.startedAt);
      const elapsed = formatElapsedDuration(end - start);
      if (elapsed) {
        return { ...item, label: `Failed after ${elapsed}` };
      }
    }
    return item;
  });

  for (let i = 0; i < enriched.length; i += 1) {
    const item = enriched[i]!;
    lines.push(
      formatActivityDisplayLine(item, {
        live: input.live,
        isLast: i === enriched.length - 1,
        quoteNarration: true
      })
    );
  }

  return lines.join("\n");
}

export function formatLifecycleHumanMessage(input: {
  lifecycle:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "requester_wait_expired"
    | "peer_transport_unavailable";
  peerLabel: string;
  requestId?: string;
  elapsedMs?: number;
}): string {
  const peer = input.peerLabel.trim() || "Remote agent";
  const req = input.requestId ? ` Request: ${input.requestId}` : "";
  const elapsed = formatElapsedDuration(input.elapsedMs);

  switch (input.lifecycle) {
    case "running":
      return `${peer}'s agent is still working.${req}`;
    case "requester_wait_expired":
      return (
        `${peer}'s agent is still working.${req}\n` +
        `Resume with the same requestId (pairmesh_wait_for_inspection) — do not start a new ask.`
      );
    case "completed":
      return elapsed ? `✓ Completed in ${elapsed}` : "✓ Completed";
    case "failed":
      return elapsed
        ? `✗ ${peer}'s agent failed after ${elapsed}.\nAroko did not receive a completed answer.`
        : `✗ ${peer}'s agent failed while working on the request.`;
    case "cancelled":
      return "○ Request cancelled.";
    case "timed_out":
      return elapsed
        ? `✗ ${peer}'s agent timed out after ${elapsed}.`
        : `✗ ${peer}'s agent timed out.`;
    case "peer_transport_unavailable":
      return (
        `✗ Aroko couldn't reach ${peer}'s agent.${req}\n` +
        `The remote agent may still be working — resume the same requestId when the route recovers (do not start a new ask).`
      );
    default:
      return `${peer}'s agent is working.${req}`;
  }
}
