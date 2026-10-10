
import { buildYourAgentCard, mapRuntimeConnectionLabel } from "./home-present.js";

/** Human provider readiness — only what status can truthfully report. */
export function mapProviderHealth(status) {
  const providerId = status?.codingAgent?.provider;
  const running = status?.runtime?.running === true;
  if (!providerId) {
    return {
      label: "Not configured",
      tone: "muted",
      detail: "Choose an agent from the Aroko CLI to get started."
    };
  }
  if (!running) {
    return {
      label: "Unavailable",
      tone: "danger",
      detail: "Start the Aroko runtime to use your agent."
    };
  }
  const explicit = status?.codingAgent?.status;
  if (typeof explicit === "string" && explicit.trim()) {
    const normalized = explicit.trim().toLowerCase();
    if (normalized.includes("fail") || normalized.includes("error")) {
      return { label: "Needs attention", tone: "warn", detail: null };
    }
    if (normalized.includes("ready") || normalized.includes("ok")) {
      return { label: "Ready", tone: "ok", detail: null };
    }
  }
  return { label: "Ready", tone: "ok", detail: null };
}

/**
 * Settings Connection section — human labels; optional relay lifecycle when known.
 */
export function mapSettingsConnectionLabel(status, relay) {
  const running = status?.runtime?.running === true;
  if (!running) {
    return { label: "Offline", tone: "danger", helper: null };
  }
  if (relay && relay.mode === "relay") {
    const lifecycle = relay.lifecycle;
    if (lifecycle === "reconnecting") {
      return {
        label: "Reconnecting…",
        tone: "warn",
        helper: "Aroko uses this connection to reach people you've connected with."
      };
    }
    if (lifecycle === "starting") {
      return {
        label: "Connecting…",
        tone: "warn",
        helper: "Aroko uses this connection to reach people you've connected with."
      };
    }
    if (lifecycle === "offline" || lifecycle === "auth_failed" || lifecycle === "stopped") {
      return {
        label: "Offline",
        tone: "danger",
        helper: "Aroko uses this connection to reach people you've connected with."
      };
    }
    if (lifecycle === "ready") {
      return {
        label: "Connected",
        tone: "ok",
        helper: "Aroko uses this connection to reach people you've connected with."
      };
    }
  }
  const base = mapRuntimeConnectionLabel(status);
  return {
    label: base.label,
    tone: base.tone,
    helper: "Aroko uses this connection to reach people you've connected with."
  };
}

/** Notification row for Settings — reuses notification status snapshot fields. */
export function mapNotificationSettingsLabel(notify) {
  if (!notify || typeof notify !== "object") {
    return {
      label: "Unavailable",
      tone: "muted",
      detail: "Notification status isn't available right now.",
      canEnable: false,
      canOpenSettings: false,
      primaryAction: "none"
    };
  }
  const auth = notify.authorization;
  if (auth === "authorized") {
    return {
      label: "On",
      tone: "ok",
      detail: "You'll be notified when someone needs your approval.",
      canEnable: false,
      canOpenSettings: notify.canOpenSettings === true,
      primaryAction: "none"
    };
  }
  if (auth === "denied") {
    return {
      label: "Needs browser permission",
      tone: "warn",
      detail: notify.body ?? "Open your system notification settings to allow Aroko alerts.",
      canEnable: false,
      canOpenSettings: notify.canOpenSettings === true,
      primaryAction: notify.canOpenSettings ? "open_settings" : "none"
    };
  }
  if (auth === "not_determined") {
    return {
      label: "Off",
      tone: "muted",
      detail: notify.body ?? "Enable notifications so you know when a collaborator needs you.",
      canEnable: notify.canRequestPermission === true,
      canOpenSettings: false,
      primaryAction: notify.canRequestPermission ? "enable" : "none"
    };
  }
  if (auth === "unavailable" || auth === "unsupported") {
    return {
      label: "Unavailable",
      tone: "muted",
      detail: notify.body ?? "Notifications aren't supported on this platform yet.",
      canEnable: false,
      canOpenSettings: false,
      primaryAction: "none"
    };
  }
  return {
    label: "Off",
    tone: "muted",
    detail: notify.body ?? null,
    canEnable: notify.canRequestPermission === true,
    canOpenSettings: notify.canOpenSettings === true,
    primaryAction: notify.primaryAction ?? "none"
  };
}

export function formatAboutVersion(status) {
  const version = typeof status?.version === "string" ? status.version.trim() : null;
  const buildId = typeof status?.buildId === "string" ? status.buildId.trim() : null;
  const buildTimestamp =
    typeof status?.buildTimestamp === "string" ? status.buildTimestamp.trim() : null;
  return {
    productName: "Aroko",
    versionLine: version ? `Version ${version}` : "Version unavailable",
    buildLine: buildId ? `Build ${buildId}` : null,
    buildTimestamp: buildTimestamp ?? null
  };
}

export function buildUpdatesSection(status) {
  const deferred = status?.deferredRestart;
  if (deferred?.pending === true) {
    const target = deferred.targetBuildId ? ` (${deferred.targetBuildId})` : "";
    return {
      headline: "Restart required",
      body: `An update was installed${target}. Restart the Aroko runtime when you're ready.`,
      tone: "warn"
    };
  }
  return {
    headline: "Updates",
    body: "Automatic update checking isn't available yet.",
    tone: "muted"
  };
}

/** Safe project label for Settings primary surface. */
export function resolveProjectDisplay(status) {
  const card = buildYourAgentCard(status);
  if (card.projectLabel) {
    return {
      label: card.projectLabel,
      configured: true,
      cliHint: null
    };
  }
  const hasOpaqueId =
    typeof status?.projectId === "string" &&
    status.projectId.trim() &&
    !status.projectId.includes("/") &&
    !status.projectId.includes("\\");
  if (hasOpaqueId) {
    return {
      label: status.projectId.trim(),
      configured: true,
      cliHint: null
    };
  }
  return {
    label: "Not configured",
    configured: false,
    cliHint: "aroko init"
  };
}

export function buildAgentChangeHint() {
  return {
    message: "Agent changes are currently made from the Aroko CLI.",
    command: "aroko config set --key codingAgent.provider --value claude-code"
  };
}

/** Advanced diagnostics rows — technical but no secrets. */
export function buildAdvancedDiagnostics(status, relay, peerCount = 0) {
  const agent = buildYourAgentCard(status);
  const rows = [];

  rows.push({
    label: "Runtime",
    value: status?.runtime?.running ? "Running" : "Stopped"
  });

  if (status?.session?.present) {
    if (status.session.sessionCode) {
      rows.push({ label: "Session code", value: status.session.sessionCode });
    }
    rows.push({
      label: "Session",
      value: status.session.status ?? (status.session.authenticated ? "Active" : "Present")
    });
    rows.push({ label: "People connected", value: String(peerCount) });
  } else {
    rows.push({ label: "Session", value: "None" });
  }

  if (agent.providerId) {
    rows.push({ label: "Agent provider", value: agent.providerId });
  }

  if (relay && relay.mode === "relay") {
    if (relay.relayWsUrl) {
      rows.push({ label: "Relay URL", value: relay.relayWsUrl });
    }
    rows.push({ label: "Relay state", value: relay.lifecycle ?? "unknown" });
    if (relay.role && relay.role !== "idle") {
      rows.push({ label: "Relay role", value: relay.role });
    }
    if (typeof relay.peerReady === "boolean") {
      rows.push({ label: "Peer route", value: relay.peerReady ? "Ready" : "Not ready" });
    }
  } else if (relay?.mode === "off") {
    rows.push({ label: "Relay", value: "Not active" });
  }

  const about = formatAboutVersion(status);
  if (about.buildLine) {
    rows.push({ label: "Build ID", value: status.buildId });
  }

  if (typeof status?.runtime?.mode === "string") {
    rows.push({ label: "Runtime mode", value: status.runtime.mode });
  }

  if (status?.runtime?.idle === false && Array.isArray(status.runtime.busyReasons)) {
    rows.push({ label: "Busy", value: status.runtime.busyReasons.join(", ") });
  }

  // Workspace path only in Advanced when local owner diagnostics need it.
  if (
    typeof status?.workspace === "string" &&
    status.workspace.trim() &&
    (status.workspace.includes("/") || status.workspace.includes("\\"))
  ) {
    rows.push({ label: "Workspace path", value: status.workspace.trim() });
  }

  return rows;
}

const SECRET_FIELD_PATTERN =
  /token|secret|credential|password|invite|bearer|authorization|authHeader|privateKey/i;

/** Reject diagnostic payloads that accidentally include sensitive keys. */
export function diagnosticObjectContainsSecrets(value, depth = 0) {
  if (depth > 6 || value == null) return false;
  if (typeof value === "string") {
    if (/Bearer\s+[A-Za-z0-9._-]+/i.test(value)) return true;
    if (/pm_[a-z]+_[A-Za-z0-9+/=]{16,}/i.test(value)) return true;
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => diagnosticObjectContainsSecrets(entry, depth + 1));
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_FIELD_PATTERN.test(key)) return true;
      if (diagnosticObjectContainsSecrets(entry, depth + 1)) return true;
    }
  }
  return false;
}

/** Plain-text diagnostic bundle safe to copy — no credentials. */
export function buildSafeDiagnosticSummary(input) {
  const status = input?.status ?? null;
  const relay = input?.relay ?? null;
  const peerCount = typeof input?.peerCount === "number" ? input.peerCount : 0;
  const about = formatAboutVersion(status);
  const agent = buildYourAgentCard(status);
  const connection = mapSettingsConnectionLabel(status, relay);
  const lines = [
    "Aroko diagnostics",
    `Generated: ${new Date().toISOString()}`,
    about.versionLine,
    ...(about.buildLine ? [about.buildLine] : []),
    `Runtime: ${status?.runtime?.running ? "running" : "stopped"}`,
    `Connection: ${connection.label}`,
    `Agent: ${agent.providerId ?? "not configured"}`,
    `People connected: ${peerCount}`
  ];
  if (relay && relay.mode === "relay") {
    if (relay.relayWsUrl) lines.push(`Relay URL: ${relay.relayWsUrl}`);
    lines.push(`Relay state: ${relay.lifecycle ?? "unknown"}`);
  }
  if (status?.session?.sessionCode) {
    lines.push(`Session code: ${status.session.sessionCode}`);
  }
  const payload = {
    product: "Aroko",
    version: status?.version,
    buildId: status?.buildId,
    runtime: status?.runtime?.running ? "running" : "stopped",
    connection: connection.label,
    providerId: agent.providerId,
    peerCount,
    relayLifecycle: relay?.mode === "relay" ? relay.lifecycle : null,
    relayWsUrl: relay?.mode === "relay" ? relay.relayWsUrl : null,
    sessionCode: status?.session?.sessionCode ?? null,
    timestamp: new Date().toISOString()
  };
  if (diagnosticObjectContainsSecrets(payload)) {
    return { text: lines.join("\n"), safe: false };
  }
  return { text: lines.join("\n"), safe: true };
}

export function canLeaveSession(status) {
  return status?.session?.present === true;
}

export function leaveSessionCopy() {
  return {
    title: "Leave this session?",
    body: "This clears your local session on this machine — collaborators will no longer reach you here. Local collaboration history stored in this session will no longer be available in Aroko.",
    confirm: "Leave session",
    cancel: "Cancel"
  };
}

export function buildSettingsModel(input) {
  const status = input?.status ?? null;
  const relay = input?.relay ?? null;
  const notify = input?.notify ?? null;
  const peerCount = typeof input?.peerCount === "number" ? input.peerCount : 0;

  const agent = buildYourAgentCard(status);
  const providerHealth = mapProviderHealth(status);
  const project = resolveProjectDisplay(status);
  const connection = mapSettingsConnectionLabel(status, relay);
  const notifications = mapNotificationSettingsLabel(notify);
  const about = formatAboutVersion(status);
  const updates = buildUpdatesSection(status);
  const advanced = buildAdvancedDiagnostics(status, relay, peerCount);
  const agentChange = buildAgentChangeHint();
  const leave = {
    available: canLeaveSession(status),
    copy: leaveSessionCopy()
  };

  return {
    agent: {
      displayName: agent.provider,
      providerId: agent.providerId,
      health: providerHealth,
      agentName: agent.agentName,
      changeHint: agentChange
    },
    project,
    notifications,
    connection,
    about,
    updates,
    advanced,
    leave,
    diagnostics: buildSafeDiagnosticSummary({ status, relay, peerCount })
  };
}

/** Fail if Settings HTML would expose forbidden primary-surface tokens. */
export function settingsHtmlContainsForbiddenTech(html) {
  const text = String(html ?? "");
  const patterns = [
    /connectionId/i,
    /a2aAgentUrl/i,
    /peerAgentUrl/i,
    /ProgressEvent/i,
    /\bMCP\b/,
    /\bA2A\b/,
    /agentUrl/i,
    /inviteSecret/i,
    /Bearer\s+/i,
    /allow_session/,
    /approval_required/,
    /capabilityId/,
    /egress generation/i
  ];
  return patterns.some((re) => re.test(text));
}
