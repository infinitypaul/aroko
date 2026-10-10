
export const PROVIDER_LABELS = {
  "claude-code": "Claude Code",
  cursor: "Cursor Agent",
  "gemini-cli": "Gemini CLI",
  fake: "Fake Coding Agent"
};

/** Canonical Control Center views (product shell). */
export const CONTROL_CENTER_VIEWS = ["home", "people", "live", "needs-you", "history", "settings"];

/**
 * Map legacy deep-link views to Control Center views.
 * inbox → needs-you, activity → live, history → history.
 */
export function normalizeControlCenterView(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "inbox") return "needs-you";
  if (value === "activity") return "live";
  if (CONTROL_CENTER_VIEWS.includes(value)) return value;
  return "home";
}

export function formatProviderDisplayName(id) {
  if (!id || typeof id !== "string") return null;
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * Human connection label for local runtime/session (Home header).
 * Uses only fields that exist on Control status — does not invent reachability.
 */
export function mapRuntimeConnectionLabel(status, relay) {
  if (!status || typeof status !== "object") {
    return { label: "Not connected", tone: "danger" };
  }
  const running = status.runtime?.running === true;
  const sessionPresent = status.session?.present === true;
  const sessionStatus = status.session?.status;
  if (!running) {
    return { label: "Not connected", tone: "danger" };
  }
  if (relay && relay.mode === "relay") {
    if (relay.lifecycle === "reconnecting") {
      return { label: "Reconnecting…", tone: "warn" };
    }
    if (relay.lifecycle === "starting") {
      return { label: "Connecting…", tone: "warn" };
    }
    if (relay.lifecycle === "offline" || relay.lifecycle === "auth_failed") {
      return { label: "Offline", tone: "danger" };
    }
  }
  if (!sessionPresent) {
    return { label: "Connected", tone: "ok", detail: "No collaboration session yet" };
  }
  if (sessionStatus === "closed") {
    return { label: "Not connected", tone: "danger", detail: "Session closed" };
  }
  return { label: "Connected", tone: "ok" };
}

/**
 * Human peer reachability — never exposes URLs or ids.
 */
export function mapPeerConnectionLabel(peer) {
  if (!peer || typeof peer !== "object") {
    return { label: "Offline", tone: "muted" };
  }
  const connectivity = peer.connectivity;
  const agent = peer.agent;
  if (connectivity === "reconnecting") {
    return { label: "Connecting…", tone: "warn" };
  }
  if (connectivity === "offline" || connectivity === "none") {
    return { label: "Offline", tone: "muted" };
  }
  if (connectivity === "unknown") {
    return { label: "Temporarily unreachable", tone: "warn" };
  }
  // connectivity ready / undefined
  if (agent === "unavailable") {
    return { label: "Temporarily unreachable", tone: "warn" };
  }
  if (agent === "ready" || peer.health?.readyForInspection === true) {
    return { label: "Ready", tone: "ok" };
  }
  if (peer.health?.reachable === false) {
    return { label: "Temporarily unreachable", tone: "warn" };
  }
  if (connectivity === "ready" || agent === "unknown" || agent === undefined) {
    return { label: "Ready", tone: "ok" };
  }
  return { label: "Ready", tone: "ok" };
}

/** Safe local agent card for Home — never absolute workspace paths. */
export function buildYourAgentCard(status) {
  const providerId = status?.codingAgent?.provider;
  const provider = formatProviderDisplayName(providerId) ?? "Not configured";
  const agentName =
    typeof status?.session?.localAgent === "string" && status.session.localAgent.trim()
      ? status.session.localAgent.trim()
      : typeof status?.runtime?.agentName === "string" && status.runtime.agentName.trim()
        ? status.runtime.agentName.trim()
        : null;
  // projectId is opaque id — not a filesystem path. Prefer display only if short/safe.
  const projectId =
    typeof status?.projectId === "string" && status.projectId.trim()
      ? status.projectId.trim()
      : null;
  const safeProjectHint =
    projectId && !projectId.includes("/") && !projectId.includes("\\") && projectId.length <= 48
      ? projectId
      : null;
  return {
    provider,
    providerId: providerId ?? null,
    agentName,
    projectLabel: safeProjectHint,
    hasAbsoluteWorkspace: typeof status?.workspace === "string" && status.workspace.includes("/")
  };
}

export function personDisplayName(peer) {
  if (!peer) return "Someone";
  if (typeof peer.displayName === "string" && peer.displayName.trim()) {
    return peer.displayName.trim();
  }
  if (typeof peer.peer === "string" && peer.peer.trim()) {
    return peer.peer.trim();
  }
  return "Someone";
}

export function truncateQuestion(text, max = 72) {
  const value = String(text ?? "").trim();
  if (!value) return "a question";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function summarizeActiveInspection(inspection) {
  const who = personDisplayName(inspection?.peer);
  const q = truncateQuestion(inspection?.question ?? inspection?.requestSummary);
  return {
    id: inspection?.requestId ?? null,
    kind: "inspection",
    title: `${who} is asking your agent about ${q}`,
    subtitle: "Working now"
  };
}

export function summarizeActiveAction(action) {
  const who = personDisplayName(action?.peer);
  const label = action?.actionLabel ?? "a request";
  const summary = truncateQuestion(action?.requestSummary ?? action?.summary ?? label, 64);
  let subtitle = "In progress";
  if (action?.status === "approved" || action?.status === "executing") {
    subtitle = "Working now";
  } else if (action?.actionType === "change.propose") {
    subtitle = "Preparing proposal";
  } else if (action?.actionType === "tests.run") {
    subtitle = "Running tests";
  } else if (action?.actionType === "process.execute") {
    subtitle = "Running command";
  } else if (action?.actionType === "repository.edit") {
    subtitle = "Applying change";
  }
  return {
    id: action?.actionId ?? null,
    kind: "action",
    title: `${who} · ${summary}`,
    subtitle
  };
}

export function summarizeNeedsYouAction(action) {
  const who = personDisplayName(action?.peer);
  let title = `${who}'s request needs your approval`;
  if (action?.actionType === "repository.edit") {
    title = `${who} wants to apply a proposed change`;
  } else if (action?.actionType === "change.propose") {
    title = `${who} wants to propose a code change`;
  } else if (action?.actionType === "tests.run") {
    title = `${who} wants to run your tests`;
  } else if (action?.actionType === "process.execute") {
    title = `${who} wants to run a command`;
  }
  return {
    id: action?.actionId ?? null,
    kind: "action",
    title,
    subtitle:
      action?.actionType === "process.execute" && action?.processExecution?.commandDisplay
        ? truncateQuestion(action.processExecution.commandDisplay, 64)
        : "Review",
    cta: "Review"
  };
}

export function summarizeNeedsYouPermission(pending) {
  const who =
    (typeof pending?.displayName === "string" && pending.displayName.trim()) ||
    (typeof pending?.peerName === "string" && pending.peerName.trim()) ||
    "Someone";
  let title = `${who}'s request needs your approval`;
  const cap = pending?.capabilityId;
  if (cap === "repository.inspect") title = `${who} wants to ask questions about your code`;
  else if (cap === "repository.source_references")
    title = `${who} wants to receive file references`;
  else if (cap === "change.propose") title = `${who} wants to propose a code change`;
  else if (cap === "repository.edit") title = `${who} wants to apply a code change`;
  else if (cap === "tests.run") title = `${who} wants to run your test profiles`;
  else if (cap === "process.execute") title = `${who} wants to run a command`;
  return {
    id: pending?.permissionRequestId ?? null,
    kind: "permission",
    title,
    subtitle: "Review",
    cta: "Review"
  };
}

export function summarizeActiveCollaborativeTask(task) {
  const requester =
    (typeof task?.requester?.displayName === "string" && task.requester.displayName.trim()) ||
    "Someone";
  const owner =
    (typeof task?.owner?.displayName === "string" && task.owner.displayName.trim()) || "owner";
  return {
    id: task?.taskId ?? task?.id ?? null,
    kind: "collaborative_task",
    title: `${requester} → ${owner}`,
    subtitle: truncateQuestion(task?.goalSummary ?? task?.phaseLabel ?? "Goal in progress", 64)
  };
}

export function summarizePendingInputRequest(input) {
  const owner =
    (typeof input?.owner?.displayName === "string" && input.owner.displayName.trim()) || "Someone";
  return {
    id: input?.inputRequestId ?? input?.id ?? null,
    kind: "input_request",
    title: `${owner} needs your answer`,
    subtitle: truncateQuestion(input?.question, 64),
    cta: "Answer"
  };
}

/** Build Home model from parallel API payloads. Caps lists for overview density. */
export function buildHomeModel(input) {
  const status = input?.status ?? null;
  const relay = input?.relay ?? null;
  const peers = Array.isArray(input?.peers) ? input.peers : [];
  const activeActions = Array.isArray(input?.activeActions) ? input.activeActions : [];
  const activeInspections = Array.isArray(input?.activeInspections) ? input.activeInspections : [];
  const activeTasks = Array.isArray(input?.activeTasks) ? input.activeTasks : [];
  const pendingActions = Array.isArray(input?.pendingActions) ? input.pendingActions : [];
  const pendingPermissions = Array.isArray(input?.pendingPermissions)
    ? input.pendingPermissions
    : [];
  const pendingInputs = Array.isArray(input?.pendingInputs) ? input.pendingInputs : [];

  const connection = mapRuntimeConnectionLabel(status, relay);
  const yourAgent = buildYourAgentCard(status);

  const activePeers = peers.filter(
    (peer) => peer?.relationship === "paired" || (!peer?.relationship && peer?.participantId)
  );
  const people = activePeers.slice(0, 6).map((peer) => {
    const conn = mapPeerConnectionLabel(peer);
    const agentLabel = formatProviderDisplayName(peer?.codingAgentProvider) ?? null;
    return {
      participantId: peer.participantId,
      name: personDisplayName(peer),
      service: typeof peer.service === "string" && peer.service.trim() ? peer.service.trim() : null,
      connection: conn,
      meta: agentLabel ? `${agentLabel} · ${conn.label}` : conn.label
    };
  });

  const active = [
    ...activeInspections.slice(0, 4).map(summarizeActiveInspection),
    ...activeActions.slice(0, 4).map(summarizeActiveAction),
    ...activeTasks.slice(0, 4).map(summarizeActiveCollaborativeTask)
  ].slice(0, 5);

  const needsYou = [
    ...pendingInputs.slice(0, 5).map(summarizePendingInputRequest),
    ...pendingActions.slice(0, 5).map(summarizeNeedsYouAction),
    ...pendingPermissions.slice(0, 3).map(summarizeNeedsYouPermission)
  ].slice(0, 5);

  const onboarding = buildOnboardingModel(status, activePeers.length);

  return {
    connection,
    yourAgent,
    people,
    active,
    needsYou,
    onboarding,
    peerCount: activePeers.length,
    activeTaskCount: activeTasks.length,
    pendingInputCount: pendingInputs.length,
    emptyPeople: activePeers.length === 0,
    emptyActive: active.length === 0,
    emptyNeedsYou: needsYou.length === 0
  };
}

/** Lightweight first-use guidance — disappears when setup is complete and peers exist. */
export function buildOnboardingModel(status, peerCount = 0) {
  const running = status?.runtime?.running === true;
  const agent = buildYourAgentCard(status);
  const hasProvider = Boolean(agent.providerId);
  const hasProject =
    Boolean(agent.projectLabel) ||
    (typeof status?.projectId === "string" &&
      status.projectId.trim() &&
      !status.projectId.includes("/") &&
      !status.projectId.includes("\\"));

  if (!running) {
    return {
      show: true,
      tone: "warn",
      headline: "Start Aroko to get ready",
      body: "Run the Aroko runtime on this machine before connecting with someone.",
      cta: null,
      cliHint: "aroko start",
      kind: "runtime"
    };
  }
  if (!hasProvider) {
    return {
      show: true,
      tone: "warn",
      headline: "Choose an agent to get Aroko ready",
      body: "Configure which coding agent Aroko should use on this machine.",
      cta: null,
      cliHint: "aroko config set --key codingAgent.provider --value claude-code",
      kind: "provider"
    };
  }
  if (!hasProject) {
    return {
      show: true,
      tone: "warn",
      headline: "Set up your project",
      body: "Initialize Aroko in your project workspace to finish setup.",
      cta: null,
      cliHint: "aroko init",
      kind: "project"
    };
  }
  if (peerCount === 0) {
    return {
      show: true,
      tone: "ok",
      headline: "Aroko is ready.",
      body: "Connect someone to let your agents work together.",
      cta: "Connect someone",
      kind: "connect"
    };
  }
  return { show: false, kind: "complete" };
}

/** Fail if primary Home HTML would expose forbidden technical tokens. */
export function homeHtmlContainsForbiddenTech(html) {
  const text = String(html ?? "");
  const patterns = [
    /connectionId/i,
    /a2aAgentUrl/i,
    /peerAgentUrl/i,
    /ProgressEvent/i,
    /\bMCP\b/,
    /\bA2A\b/,
    /agentUrl/i,
    /127\.0\.0\.1:\d+/
  ];
  return patterns.some((re) => re.test(text));
}

export function actionListFilterForView(view) {
  const normalized = normalizeControlCenterView(view);
  if (normalized === "needs-you") return "pending";
  if (normalized === "live") return "active";
  if (normalized === "history") return "recent";
  return null;
}
