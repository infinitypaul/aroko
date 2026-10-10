
export const ACTIVITY_POLL_MS = 1000;
export const DEFAULT_POLL_MS = 3000;
export const MAX_PROGRESS_EVENTS = 200;

export const PHASE_LABELS = {
  request_received: "Request delivered",
  authenticating: "Connecting",
  authorizing: "Authorizing",
  awaiting_owner_approval: "Waiting for approval",
  approved: "Approved",
  proposal_preparing: "Preparing change…",
  proposal_ready: "Waiting for approval",
  applying: "Applying change…",
  running_named_tests: "Running tests…",
  executing: "Working…",
  provider_started: "Started",
  investigating: "Investigating",
  reading_searching: "Investigating",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired",
  partially_completed: "Partially completed",
  unknown_outcome: "Unknown outcome"
};

/** Approved safeMetadata keys only — never render arbitrary metadata. */
export const APPROVED_METADATA_KEYS = [
  "relativePath",
  "toolName",
  "query",
  "testProfile",
  "durationMs",
  "provider",
  "correlationId"
];

/**
 * Human label for a ProgressEvent.
 * Prefer activityKind when present; fall back to coarse ProgressPhase.
 */
export function formatActivityLabel(event) {
  const kind = event?.activityKind;
  const meta =
    event?.safeMetadata && typeof event.safeMetadata === "object" ? event.safeMetadata : {};
  const message = typeof event?.message === "string" ? event.message.trim() : "";

  switch (kind) {
    case "worker.started":
      return "Started";
    case "provider.message":
      return message || "Working…";
    case "file.read":
      return meta.relativePath
        ? `Reading ${String(meta.relativePath)}…`
        : message || "Reading file…";
    case "search.started":
      return meta.query ? `Searching ${String(meta.query)}…` : message || "Searching repository…";
    case "search.completed":
      return "Search complete";
    case "tool.started":
      return meta.toolName ? `Using ${String(meta.toolName)}…` : message || "Using a tool…";
    case "tool.in_progress":
      return meta.toolName
        ? `${String(meta.toolName)} in progress…`
        : message || "Tool in progress…";
    case "tool.completed":
      return meta.toolName ? `${String(meta.toolName)} completed` : message || "Tool completed";
    case "tool.failed":
      return meta.toolName ? `${String(meta.toolName)} failed` : message || "Tool failed";
    case "command.started":
      return message || "Running command…";
    case "command.completed":
      return message || "Command completed";
    case "command.failed":
      return message || "Command failed";
    case "test.started":
      return meta.testProfile
        ? `Running ${String(meta.testProfile)}…`
        : message || "Running tests…";
    case "test.completed":
      if (typeof meta.passed === "number" && typeof meta.failed === "number") {
        if (meta.failed > 0) {
          return `Tests failed (${meta.passed} passed / ${meta.failed} failed)`;
        }
        return `${meta.passed} tests passed`;
      }
      return meta.testProfile ? `${String(meta.testProfile)} completed` : message || "Tests passed";
    case "finding":
      return message
        ? String(message).startsWith("Found")
          ? message
          : `Found: ${message}`
        : "Found a result";
    case "proposal.preparing":
      return "Preparing change…";
    case "proposal.ready":
      return "Waiting for approval";
    case "worker.completed":
      return "Completed";
    case "worker.failed":
      return "Failed";
    case "worker.cancelled":
      return "Cancelled";
    default:
      if (kind) {
        return message || String(kind);
      }
      if (event?.phase === "provider_started") return "Started";
      if (event?.phase === "investigating" || event?.phase === "reading_searching") {
        return "Investigating";
      }
      return PHASE_LABELS[event?.phase] ?? event?.phase ?? "Update";
  }
}

export function progressEventKey(event) {
  if (event?.providerEventId) {
    return `id:${event.providerEventId}`;
  }
  if (typeof event?.sequence === "number") {
    return `seq:${event.operationId ?? ""}:${event.sequence}`;
  }
  return `fallback:${event?.timestamp ?? ""}:${event?.phase ?? ""}:${event?.activityKind ?? ""}:${event?.message ?? ""}`;
}

export function prepareProgressTimeline(events) {
  const list = Array.isArray(events) ? [...events] : [];
  list.sort((a, b) => {
    const sa = typeof a.sequence === "number" ? a.sequence : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.sequence === "number" ? b.sequence : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""));
  });
  const seen = new Set();
  const out = [];
  let lastLabel = undefined;
  for (const event of list) {
    const key = progressEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = formatActivityLabel(event);
    const kind = event?.activityKind;
    const alwaysKeep =
      kind === "worker.started" ||
      kind === "worker.completed" ||
      kind === "worker.failed" ||
      kind === "worker.cancelled" ||
      kind === "provider.message" ||
      kind === "finding" ||
      kind === "tool.failed" ||
      kind === "proposal.ready";
    if (
      !alwaysKeep &&
      lastLabel === label &&
      (label === "Investigating" || label === "Reading / searching")
    ) {
      continue;
    }
    out.push(event);
    lastLabel = label;
  }
  if (out.length > MAX_PROGRESS_EVENTS) {
    return out.slice(out.length - MAX_PROGRESS_EVENTS);
  }
  return out;
}

/**
 * Explicit approved-field chips only — never dump raw metadata objects.
 */
export function formatApprovedMetadataChips(meta) {
  if (!meta || typeof meta !== "object") {
    return [];
  }
  const chips = [];
  if (typeof meta.relativePath === "string" && meta.relativePath.trim()) {
    chips.push({ key: "path", label: meta.relativePath.trim() });
  }
  if (typeof meta.query === "string" && meta.query.trim()) {
    chips.push({ key: "query", label: meta.query.trim() });
  }
  if (typeof meta.toolName === "string" && meta.toolName.trim()) {
    chips.push({ key: "tool", label: meta.toolName.trim() });
  }
  if (typeof meta.testProfile === "string" && meta.testProfile.trim()) {
    chips.push({ key: "test", label: meta.testProfile.trim() });
  }
  if (typeof meta.provider === "string" && meta.provider.trim()) {
    chips.push({ key: "provider", label: meta.provider.trim() });
  }
  if (typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs)) {
    chips.push({ key: "duration", label: `${meta.durationMs}ms` });
  }
  // correlationId intentionally omitted from UI (internal)
  return chips;
}

export function isActionReviewable(action) {
  if (!action) return false;
  if (action.status === "approval_required" && action.needsApproval) return true;
  const progress = Array.isArray(action.progress) ? action.progress : [];
  return progress.some(
    (event) => event.activityKind === "proposal.ready" || event.phase === "proposal_ready"
  );
}

export function isActionActivelyRunning(action) {
  if (!action) return false;
  return action.status === "executing" || action.status === "approved";
}

export function resolvePollIntervalMs(input) {
  const tab = input?.tab ?? input?.view ?? "inbox";
  if (tab === "activity" || tab === "live" || tab === "home") {
    return ACTIVITY_POLL_MS;
  }
  if (input?.selectedAction && isActionActivelyRunning(input.selectedAction)) {
    return ACTIVITY_POLL_MS;
  }
  if (Array.isArray(input?.actions) && input.actions.some(isActionActivelyRunning)) {
    return ACTIVITY_POLL_MS;
  }
  return DEFAULT_POLL_MS;
}

export function coarseStateLabel(action) {
  if (!action) return "Unknown";
  if (action.latestProgress?.activityKind) {
    return formatActivityLabel(action.latestProgress);
  }
  if (action.latestProgress?.phase) {
    return PHASE_LABELS[action.latestProgress.phase] ?? action.latestProgress.phase;
  }
  return String(action.status ?? "unknown").replace(/_/g, " ");
}
