import {
  ACTIVITY_POLL_MS,
  coarseStateLabel,
  formatActivityLabel,
  formatApprovedMetadataChips,
  isActionReviewable,
  prepareProgressTimeline
} from "./activity-present.js";
import {
  buildHomeModel,
  formatProviderDisplayName,
  homeHtmlContainsForbiddenTech,
  mapRuntimeConnectionLabel,
  normalizeControlCenterView,
  personDisplayName
} from "./home-present.js";
import {
  buildInviteShareModel,
  buildPeopleListModel,
  buildPersonDetailModel,
  findPeerBySelection,
  humanizeJoinError,
  humanizePermissionError,
  humanizeRemoveError,
  isAllowSessionForbidden,
  isActiveCollaborator,
  peopleHtmlContainsForbiddenTech
} from "./people-present.js";
import {
  buildHistoryCardModel,
  buildHistoryDetailSections,
  buildHistoryEmptyCopy,
  findHistoryItem,
  groupHistoryItems,
  historyCategoryFilter,
  historyHtmlContainsForbiddenTech,
  mergeHistoryItems,
  sanitizeHistoryCardModel,
  sanitizeHistoryDetailSections
} from "./history-present.js";
import {
  buildLiveCardModel,
  buildLiveEmptyCopy,
  buildNeedsYouCardModel,
  capabilityApprovalCopy,
  findWorkItem,
  humanizeDecisionError,
  humanizeDecisionSuccess,
  liveHtmlContainsForbiddenTech,
  mergeLiveWorkItems,
  mergeNeedsYouItems,
  resolveLivePollIntervalMs,
  workItemKey
} from "./live-present.js";
import { buildSettingsModel, settingsHtmlContainsForbiddenTech } from "./settings-present.js";

const API_PREFIX = "/control/v1";

const PAGE_COPY = {
  home: { title: "Home", subtitle: "Your collaboration overview" },
  people: {
    title: "People",
    subtitle: "Who you're connected to"
  },
  live: { title: "Live", subtitle: "Work in progress" },
  "needs-you": { title: "Needs you", subtitle: "Approvals and decisions" },
  history: { title: "History", subtitle: "Past collaboration" },
  settings: { title: "Settings", subtitle: "Agent, connection, and diagnostics" }
};

const state = {
  token: "",
  baseUrl: "",
  view: "home",
  actions: [],
  workItems: [],
  peers: [],
  pendingPermissions: [],
  pendingInputs: [],
  collaborativeTasks: [],
  activeInspections: [],
  homeModel: null,
  selectedKind: null, // action | inspection | permission | collaborative_task | input_request
  selectedId: null,
  selectedWork: null,
  selectedAction: null, // legacy alias for action detail / poll helpers
  selectedPersonId: null,
  peoplePanel: "list", // list | connect | remove
  inviteShare: null,
  permissionBusy: null,
  deciding: false,
  historyFilter: "all",
  status: null,
  relayStatus: null,
  notify: null,
  settingsModel: null,
  settingsPanel: "main", // main | leave-confirm
  pollTimer: null,
  loadError: null,
  loadingHome: false,
  loadingSettings: false,
  leavingSession: false
};

const appEl = document.getElementById("app");
const authGate = document.getElementById("auth-gate");
const actionList = document.getElementById("action-list");
const listMeta = document.getElementById("list-meta");
const detailPanel = document.getElementById("detail-panel");
const detailContent = document.getElementById("detail-content");
const layoutEl = document.querySelector(".layout");
const notifyBanner = document.getElementById("notify-banner");
const notifyHeadline = document.getElementById("notify-headline");
const notifyBody = document.getElementById("notify-body");
const notifyPrimary = document.getElementById("notify-primary");
const notifyDismiss = document.getElementById("notify-dismiss");
const pageTitle = document.getElementById("page-title");
const pageSubtitle = document.getElementById("page-subtitle");
const providerBadge = document.getElementById("provider-badge");
const shellConnection = document.getElementById("shell-connection");
const viewFlash = document.getElementById("view-flash");
const viewHome = document.getElementById("view-home");
const viewPeople = document.getElementById("view-people");
const viewSettings = document.getElementById("view-settings");
const viewWork = document.getElementById("view-work");

function isWorkView(view) {
  return view === "live" || view === "needs-you" || view === "history";
}

function bootstrapDeepLink() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const fromCode = params.get("code");
  const fromHashToken = params.get("token");
  const actionId = params.get("action");
  const view = params.get("view");
  if (fromCode) {
    sessionStorage.setItem("pairmeshControlExchangeCode", fromCode);
  }
  // Legacy deep-links still accepted once for migration; prefer exchange code.
  if (fromHashToken && !fromCode) {
    sessionStorage.setItem("pairmeshControlToken", fromHashToken);
  }
  if (actionId) {
    sessionStorage.setItem("pairmeshDeepLinkAction", actionId);
  }
  if (view) {
    sessionStorage.setItem("pairmeshDeepLinkView", normalizeControlCenterView(view));
  }
  const person = params.get("person");
  if (person) {
    sessionStorage.setItem("arokoSelectedPerson", person);
  }
  // Strip secrets from URL immediately — keep only optional view/person.
  if (fromCode || fromHashToken || actionId || view || person) {
    const safeView = view ? normalizeControlCenterView(view) : null;
    const keep = new URLSearchParams();
    if (safeView) keep.set("view", safeView);
    if (person && (!safeView || safeView === "people")) keep.set("person", person);
    const nextHash = keep.toString() ? `#${keep.toString()}` : "";
    history.replaceState(null, "", `${window.location.pathname}${nextHash}`);
  }
  return sessionStorage.getItem("pairmeshControlToken") ?? "";
}

async function redeemExchangeCodeIfNeeded() {
  const code = sessionStorage.getItem("pairmeshControlExchangeCode");
  if (!code) {
    return;
  }
  sessionStorage.removeItem("pairmeshControlExchangeCode");
  try {
    const response = await fetch(`${state.baseUrl}/control/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok || !body?.controlToken) {
      throw new Error(body?.error || "Exchange failed");
    }
    const token = normalizeControlToken(body.controlToken);
    sessionStorage.setItem("pairmeshControlToken", token);
    state.token = token;
  } catch (error) {
    sessionStorage.removeItem("pairmeshControlToken");
    state.token = "";
    throw error;
  }
}

function persistViewInUrl(view, personId) {
  const params = new URLSearchParams();
  params.set("view", view);
  if (personId && view === "people") {
    params.set("person", personId);
  }
  const nextHash = `#${params.toString()}`;
  if (window.location.hash !== nextHash) {
    history.replaceState(null, "", `${window.location.pathname}${nextHash}`);
  }
  sessionStorage.setItem("arokoControlView", view);
  if (personId && view === "people") {
    sessionStorage.setItem("arokoSelectedPerson", personId);
  } else if (view !== "people") {
    sessionStorage.removeItem("arokoSelectedPerson");
  }
}

function showAuth(errorMessage) {
  authGate.classList.remove("hidden");
  appEl.classList.add("hidden");
  const err = document.getElementById("auth-error");
  const input = document.getElementById("token-input");
  if (input && state.token && !input.value) {
    input.value = state.token;
  }
  if (errorMessage) {
    err.textContent = errorMessage;
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }
}

function showApp() {
  authGate.classList.add("hidden");
  appEl.classList.remove("hidden");
}

function normalizeControlToken(raw) {
  let token = String(raw ?? "").trim();
  if (/^Bearer\s+/i.test(token)) {
    token = token.replace(/^Bearer\s+/i, "").trim();
  }
  return token;
}

async function api(path, options = {}) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    throw new Error(
      body?.error ? JSON.stringify(body.error) : `Request failed (${response.status})`
    );
  }
  return body;
}

function formatAge(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setFlash(message, tone = "info") {
  if (!message) {
    viewFlash.classList.add("hidden");
    viewFlash.textContent = "";
    return;
  }
  viewFlash.textContent = message;
  viewFlash.dataset.tone = tone;
  viewFlash.classList.remove("hidden");
}

function clearFlash() {
  setFlash("");
}

function statusBadge(status) {
  const cls =
    status === "approval_required"
      ? "pending"
      : status === "executing" || status === "approved"
        ? "executing"
        : status === "completed"
          ? "completed"
          : ["failed", "denied", "cancelled", "expired"].includes(status)
            ? status
            : "executing";
  const label =
    status === "approval_required"
      ? "needs approval"
      : String(status ?? "").replace(/_/g, " ") || "unknown";
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function peerLabel(action) {
  const peer = action.peer;
  if (!peer) return "Someone";
  const service = peer.service ? ` · ${peer.service}` : "";
  return `${peer.displayName}${service}`;
}

function workListLabel(view) {
  if (view === "needs-you") return "Needs your attention";
  if (view === "live") return "In progress";
  return "Recent completed";
}

function updateShellChrome() {
  const copy = PAGE_COPY[state.view] ?? PAGE_COPY.home;
  pageTitle.textContent = copy.title;
  pageSubtitle.textContent = copy.subtitle;

  const connection = mapRuntimeConnectionLabel(state.status, state.relayStatus);
  shellConnection.textContent = connection.label;
  shellConnection.dataset.tone = connection.tone;

  const provider = formatProviderDisplayName(state.status?.codingAgent?.provider);
  providerBadge.textContent = provider ? `Your agent · ${provider}` : "Your agent · not configured";

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    const view = btn.getAttribute("data-view");
    const active = view === state.view;
    btn.classList.toggle("active", active);
    if (active) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });
}

function showPanelForView(view) {
  viewHome.hidden = view !== "home";
  viewPeople.hidden = view !== "people";
  viewSettings.hidden = view !== "settings";
  viewWork.hidden = !isWorkView(view);
}

async function setView(view, options = {}) {
  const next = normalizeControlCenterView(view);
  state.view = next;
  if (options.personId) {
    state.selectedPersonId = options.personId;
  }
  if (next !== "people") {
    state.peoplePanel = "list";
    state.inviteShare = null;
  } else if (options.connect) {
    state.peoplePanel = "connect";
  } else if (options.personId || state.selectedPersonId) {
    state.peoplePanel = "list";
  }
  if (next !== "settings") {
    state.settingsPanel = "main";
  }
  if (!options.skipUrl) {
    persistViewInUrl(next, next === "people" ? state.selectedPersonId : null);
  }
  if (!options.keepDetail && !options.selectActionId && !options.selectWorkId) {
    closeDetail();
  }
  updateShellChrome();
  showPanelForView(next);
  clearFlash();

  try {
    if (next === "home") {
      await loadHome();
      renderHome();
    } else if (next === "people") {
      await loadPeers();
      renderPeople();
    } else if (next === "settings") {
      await loadSettings();
      renderSettings();
    } else if (isWorkView(next)) {
      await loadWorkFeed();
      renderList();
      const selectKind = options.selectWorkKind ?? (options.selectActionId ? "action" : null);
      const selectId = options.selectWorkId ?? options.selectActionId ?? null;
      if (selectKind && selectId) {
        await selectWork(selectKind, selectId);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aroko couldn't refresh this view.";
    setFlash(humanizeLoadError(message), "error");
  } finally {
    restartPolling();
  }
}

function humanizeLoadError(raw) {
  const text = String(raw ?? "");
  if (text.includes("401") || /unauthorized/i.test(text)) {
    return "Aroko couldn't authorize this view. Open again with aroko open, or paste a fresh control token.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return "Aroko couldn't reach the local runtime. Check that aroko start is running, then try again.";
  }
  return "Aroko couldn't refresh this view. Check that the local runtime is running, then try again.";
}

async function loadStatus() {
  state.status = await api(`${API_PREFIX}/status`);
}

async function loadRelayStatus() {
  try {
    state.relayStatus = await api(`${API_PREFIX}/relay`);
  } catch {
    state.relayStatus = null;
  }
}

async function loadNotificationStatus() {
  try {
    state.notify = await api(`${API_PREFIX}/notifications/status`);
    renderNotifyBanner();
  } catch {
    notifyBanner.classList.add("hidden");
  }
}

async function loadPeers() {
  const data = await api(`${API_PREFIX}/peers`);
  state.peers = data.peers ?? [];
}

async function loadPendingPermissions() {
  try {
    const data = await api(`${API_PREFIX}/permissions`);
    state.pendingPermissions = data.pending ?? [];
  } catch {
    state.pendingPermissions = [];
  }
}

async function loadActiveInspections() {
  try {
    const data = await api(`${API_PREFIX}/inspections?filter=active&limit=20`);
    state.activeInspections = data.inspections ?? [];
  } catch {
    state.activeInspections = [];
  }
}

async function loadSettings() {
  state.loadingSettings = true;
  try {
    await Promise.all([
      loadRelayStatus(),
      loadNotificationStatus().catch(() => undefined),
      loadPeers().catch(() => {
        state.peers = [];
      })
    ]);
    const activePeerCount = state.peers.filter(
      (peer) => peer?.relationship === "paired" || (!peer?.relationship && peer?.participantId)
    ).length;
    state.settingsModel = buildSettingsModel({
      status: state.status,
      relay: state.relayStatus,
      notify: state.notify,
      peerCount: activePeerCount
    });
  } finally {
    state.loadingSettings = false;
  }
}

async function loadHome() {
  state.loadingHome = true;
  try {
    const [pending, active, tasksRes, inputsRes] = await Promise.all([
      api(`${API_PREFIX}/actions?filter=pending&limit=20`).catch(() => ({ actions: [] })),
      api(`${API_PREFIX}/actions?filter=active&limit=20`).catch(() => ({ actions: [] })),
      api(`${API_PREFIX}/tasks?filter=active&limit=20`).catch(() => ({ tasks: [] })),
      api(`${API_PREFIX}/tasks/pending-inputs`).catch(() => ({ inputs: [] }))
    ]);
    await Promise.all([
      loadPeers().catch(() => {
        state.peers = [];
      }),
      loadActiveInspections(),
      loadPendingPermissions()
    ]);
    state.collaborativeTasks = tasksRes.tasks ?? [];
    state.pendingInputs = inputsRes.inputs ?? [];
    state.homeModel = buildHomeModel({
      status: state.status,
      relay: state.relayStatus,
      peers: state.peers,
      activeActions: active.actions ?? [],
      activeInspections: state.activeInspections,
      activeTasks: state.collaborativeTasks,
      pendingActions: pending.actions ?? [],
      pendingPermissions: state.pendingPermissions,
      pendingInputs: state.pendingInputs
    });
    state.loadError = null;
  } finally {
    state.loadingHome = false;
  }
}

function renderHome() {
  if (state.loadingHome && !state.homeModel) {
    viewHome.innerHTML = `<div class="state-block" data-tone="loading">Loading your overview…</div>`;
    return;
  }
  if (!state.homeModel) {
    viewHome.innerHTML = `<div class="state-block" data-tone="error">Aroko couldn't load Home.</div>`;
    return;
  }
  const model = state.homeModel;
  const agent = model.yourAgent;
  const agentMeta = [agent.agentName, agent.projectLabel].filter(Boolean).join(" · ");

  const peopleHtml = model.emptyPeople
    ? `<div class="empty-state">
        <p>Connect with someone to let your agents work together.</p>
        <button type="button" class="primary-btn" data-go="people" data-connect="1" style="margin-top:0.75rem">Connect someone</button>
      </div>`
    : `<ul class="people-list">${model.people
        .map(
          (person) => `
        <li class="interactive" tabindex="0" data-go="people" data-person="${escapeHtml(person.participantId)}">
          <div>
            <p class="name">${escapeHtml(person.name)}</p>
            <p class="meta">${escapeHtml(person.meta)}${person.service ? ` · ${escapeHtml(person.service)}` : ""}</p>
          </div>
          <span class="status-pill" data-tone="${escapeHtml(person.connection.tone)}">${escapeHtml(person.connection.label)}</span>
        </li>`
        )
        .join("")}</ul>
      <div class="home-people-actions">
        <button type="button" class="ghost-btn" data-go="people" data-connect="1">Connect someone</button>
      </div>`;

  const activeHtml = model.emptyActive
    ? `<div class="empty-state">Nothing is running right now.</div>`
    : `<ul class="overview-list">${model.active
        .map((item) => {
          const interactive = Boolean(
            item.id &&
            (item.kind === "action" ||
              item.kind === "inspection" ||
              item.kind === "collaborative_task")
          );
          const attrs = interactive
            ? `tabindex="0" data-go="live" data-work-kind="${escapeHtml(item.kind)}" data-work-id="${escapeHtml(item.id)}"`
            : "";
          return `
        <li class="${interactive ? "interactive" : ""}" ${attrs}>
          <div>
            <p class="title">${escapeHtml(item.title)}</p>
            <p class="subtitle">${escapeHtml(item.subtitle)}</p>
          </div>
        </li>`;
        })
        .join("")}</ul>`;

  const needsHtml = model.emptyNeedsYou
    ? `<div class="empty-state">You're all caught up.</div>`
    : `<ul class="overview-list">${model.needsYou
        .map((item) => {
          const interactive = Boolean(
            item.id &&
            (item.kind === "action" || item.kind === "permission" || item.kind === "input_request")
          );
          const attrs = interactive
            ? `tabindex="0" data-go="needs-you" data-work-kind="${escapeHtml(item.kind)}" data-work-id="${escapeHtml(item.id)}"`
            : `data-go="needs-you"`;
          return `
        <li class="${interactive ? "interactive" : ""}" ${attrs}>
          <div>
            <p class="title">${escapeHtml(item.title)}</p>
            <p class="subtitle">${escapeHtml(item.subtitle)}</p>
          </div>
          ${interactive ? `<span class="subtle">${escapeHtml(item.cta ?? (item.kind === "input_request" ? "Answer" : "Review"))}</span>` : ""}
        </li>`;
        })
        .join("")}</ul>`;

  const detailLine = model.connection.detail
    ? `<p class="subtle">${escapeHtml(model.connection.detail)}</p>`
    : `<p class="subtle">Calm overview of who you're connected to and what needs attention.</p>`;

  const onboarding = model.onboarding?.show
    ? `<section class="home-card home-onboarding home-span-2" data-tone="${escapeHtml(model.onboarding.tone ?? "ok")}">
        <h2>${escapeHtml(model.onboarding.headline ?? "Getting started")}</h2>
        <p class="subtle">${escapeHtml(model.onboarding.body ?? "")}</p>
        ${model.onboarding.cliHint ? `<p class="settings-cli-hint"><code>${escapeHtml(model.onboarding.cliHint)}</code></p>` : ""}
        ${model.onboarding.cta ? `<button type="button" class="primary-btn" data-go="people" data-connect="1" style="margin-top:0.75rem">${escapeHtml(model.onboarding.cta)}</button>` : ""}
      </section>`
    : "";

  const html = `
    <div class="home-grid">
      ${onboarding}
      <section class="home-card home-hero ${onboarding ? "" : "home-span-2"}">
        <span class="status-pill" data-tone="${escapeHtml(model.connection.tone)}">${escapeHtml(model.connection.label)}</span>
        ${detailLine}
      </section>
      <section class="home-card">
        <h2>Your agent</h2>
        <ul class="agent-lines">
          <li class="provider">${escapeHtml(agent.provider)}</li>
          ${agentMeta ? `<li class="meta">${escapeHtml(agentMeta)}</li>` : `<li class="meta">Project not set</li>`}
        </ul>
      </section>
      <section class="home-card">
        <h2>People</h2>
        ${peopleHtml}
      </section>
      <section class="home-card">
        <h2>Active</h2>
        ${activeHtml}
      </section>
      <section class="home-card">
        <h2>Needs you</h2>
        ${needsHtml}
      </section>
    </div>`;

  if (homeHtmlContainsForbiddenTech(html)) {
    viewHome.innerHTML = `<div class="state-block" data-tone="error">Home refused to render technical connection details.</div>`;
    return;
  }
  viewHome.innerHTML = html;
  bindHomeInteractions(viewHome);
}

function bindHomeInteractions(root) {
  root.querySelectorAll("[data-go]").forEach((el) => {
    const activate = () => {
      const go = el.getAttribute("data-go");
      const workKind = el.getAttribute("data-work-kind");
      const workId = el.getAttribute("data-work-id");
      const actionId = el.getAttribute("data-action");
      const personId = el.getAttribute("data-person");
      const connect = el.getAttribute("data-connect") === "1";
      if (!go) return;
      if (workKind && workId) {
        void setView(go, { selectWorkKind: workKind, selectWorkId: workId, keepDetail: true });
        return;
      }
      if (actionId) {
        void setView(go, {
          selectWorkKind: "action",
          selectWorkId: actionId,
          keepDetail: true
        });
        return;
      }
      void setView(go, {
        ...(personId ? { personId } : {}),
        ...(connect ? { connect: true } : {})
      });
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function renderPeople() {
  const listModel = buildPeopleListModel(state.peers);
  if (state.peoplePanel === "connect") {
    viewPeople.innerHTML = renderConnectPanelHtml();
    bindPeopleInteractions(viewPeople);
    return;
  }

  const selected = findPeerBySelection(state.peers, state.selectedPersonId);
  if (state.selectedPersonId && !selected) {
    state.selectedPersonId = null;
  }
  if (!state.selectedPersonId && listModel.people[0]) {
    // keep selection empty until user picks — show placeholder in detail
  }

  let detailHtml = "";
  if (state.peoplePanel === "remove" && selected) {
    detailHtml = renderRemoveConfirmHtml(selected);
  } else if (selected && isActiveCollaborator(selected)) {
    detailHtml = renderPersonDetailHtml(selected);
  } else if (listModel.empty) {
    detailHtml = "";
  } else {
    detailHtml = `<div class="empty-state">Select someone to see what they can ask your agent to do.</div>`;
  }

  const listHtml = listModel.empty
    ? `<div class="empty-state">
        <p>Your agents work better when they can reach the people you trust.</p>
        <button type="button" class="primary-btn" data-people-connect="1" style="margin-top:0.75rem">Connect someone</button>
      </div>`
    : `<ul class="people-list people-master-list">${listModel.people
        .map((person) => {
          const selectedCls = person.participantId === state.selectedPersonId ? "selected" : "";
          return `
          <li class="interactive ${selectedCls}" tabindex="0" data-select-person="${escapeHtml(person.participantId)}">
            <div>
              <p class="name">${escapeHtml(person.name)}</p>
              <p class="meta">${escapeHtml(person.agentLine)}${person.service ? ` · ${escapeHtml(person.service)}` : ""}</p>
              <p class="meta">Can ask your agent: ${escapeHtml(person.permissionSummary)}</p>
            </div>
            <span class="status-pill" data-tone="${escapeHtml(person.connection.tone)}">${escapeHtml(person.connection.label)}</span>
          </li>`;
        })
        .join("")}</ul>
      <div class="home-people-actions">
        <button type="button" class="primary-btn" data-people-connect="1">Connect someone</button>
      </div>`;

  const html = `
    <div class="people-layout">
      <section class="people-master home-card">
        <div class="people-master-head">
          <h2>People</h2>
        </div>
        ${listHtml}
      </section>
      <section class="people-detail home-card" id="people-detail-root">
        ${detailHtml}
      </section>
    </div>`;

  if (peopleHtmlContainsForbiddenTech(html)) {
    viewPeople.innerHTML = `<div class="state-block" data-tone="error">People refused to render technical connection details.</div>`;
    return;
  }
  viewPeople.innerHTML = html;
  bindPeopleInteractions(viewPeople);
}

function renderPersonDetailHtml(peer) {
  const detail = buildPersonDetailModel(peer);
  if (!detail) return "";
  const service = detail.service ? ` · ${escapeHtml(detail.service)}` : "";
  const permissionsHtml = detail.permissions
    .map((cap) => {
      const busy = state.permissionBusy === `${detail.peerRef}:${cap.id}`;
      const options = cap.options
        .map(
          (opt) => `
          <label class="policy-option">
            <input
              type="radio"
              name="perm-${escapeHtml(cap.id)}"
              value="${escapeHtml(opt.policy)}"
              data-cap="${escapeHtml(cap.id)}"
              data-peer="${escapeHtml(detail.peerRef)}"
              ${cap.policy === opt.policy ? "checked" : ""}
              ${busy ? "disabled" : ""}
            />
            <span>${escapeHtml(opt.label)}</span>
          </label>`
        )
        .join("");
      return `
        <fieldset class="perm-block" data-cap-block="${escapeHtml(cap.id)}">
          <legend>${escapeHtml(cap.label)}</legend>
          <p class="perm-helper subtle">${escapeHtml(cap.helper)}</p>
          <div class="policy-group" role="radiogroup" aria-label="${escapeHtml(cap.label)}">
            ${options}
          </div>
          ${busy ? `<p class="subtle" data-perm-status>Saving…</p>` : `<p class="subtle" data-perm-status></p>`}
        </fieldset>`;
    })
    .join("");

  return `
    <div class="person-detail">
      <header class="person-detail-head">
        <h2>${escapeHtml(detail.name)}</h2>
        <p class="subtle">
          <span class="status-pill" data-tone="${escapeHtml(detail.connection.tone)}">${escapeHtml(detail.connection.label)}</span>
          ${service}
        </p>
      </header>
      <section>
        <h3>What ${escapeHtml(detail.name)} can ask your agent</h3>
        ${permissionsHtml}
      </section>
      <section class="detail-section">
        <h3>What you can ask ${escapeHtml(detail.name)}'s agent</h3>
        <p class="subtle">${escapeHtml(detail.reciprocalNote)}</p>
      </section>
      <section class="detail-section">
        <h3>Connection</h3>
        <p><span class="status-pill" data-tone="${escapeHtml(detail.connection.tone)}">${escapeHtml(detail.connection.label)}</span></p>
      </section>
      <div class="actions-row">
        <button type="button" class="danger-btn" data-people-remove-start="1">${escapeHtml(detail.removeLabel)}</button>
      </div>
    </div>`;
}

function renderRemoveConfirmHtml(peer) {
  const name = personDisplayName(peer);
  return `
    <div class="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="remove-title">
      <h2 id="remove-title">Remove ${escapeHtml(name)}?</h2>
      <p>${escapeHtml(name)} will no longer be connected to this Aroko session. Their credentials and grants on your side will be cleared. Collaboration history already stored locally may still remain.</p>
      <div class="actions-row">
        <button type="button" class="ghost-btn" data-people-remove-cancel="1">Cancel</button>
        <button type="button" class="danger-btn" data-people-remove-confirm="1" data-peer="${escapeHtml(peer.peer)}">Remove ${escapeHtml(name)}</button>
      </div>
    </div>`;
}

function renderConnectPanelHtml() {
  const invite = state.inviteShare;
  const inviteBlock = invite
    ? `<div class="invite-result">
        <h3>Invite created</h3>
        <p class="subtle">Send this invite to the person you want to connect with.</p>
        <pre class="invite-value" id="invite-command-text">${escapeHtml(invite.joinCommand)}</pre>
        <div class="actions-row">
          <button type="button" class="primary-btn" data-copy-invite="1">Copy invite</button>
          <button type="button" class="ghost-btn" data-clear-invite="1">Done</button>
        </div>
        <p class="subtle">This invite can be used once.${invite.expiresLabel ? ` Expires ${escapeHtml(invite.expiresLabel)}.` : ""}</p>
      </div>`
    : `<div class="actions-row">
        <button type="button" class="primary-btn" data-create-invite="1">Create invite</button>
      </div>`;

  return `
    <div class="connect-panel home-card">
      <div class="people-master-head">
        <h2>Connect someone</h2>
        <button type="button" class="ghost-btn" data-people-back="1">← People</button>
      </div>
      <section class="detail-section">
        <h3>Invite someone</h3>
        <p class="subtle">Create an invite you can send to a teammate.</p>
        ${inviteBlock}
      </section>
      <section class="detail-section">
        <h3>Have an invite?</h3>
        <label class="field" for="join-invite-input">
          <span>Paste invite</span>
          <textarea id="join-invite-input" rows="3" placeholder="aroko join …" spellcheck="false"></textarea>
        </label>
        <div class="actions-row">
          <button type="button" class="primary-btn" data-join-invite="1">Connect</button>
        </div>
        <p class="subtle" id="join-status" role="status"></p>
      </section>
    </div>`;
}

function bindPeopleInteractions(root) {
  root.querySelectorAll("[data-select-person]").forEach((el) => {
    const activate = () => {
      state.selectedPersonId = el.getAttribute("data-select-person");
      state.peoplePanel = "list";
      persistViewInUrl("people", state.selectedPersonId);
      renderPeople();
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });

  root.querySelectorAll("[data-people-connect]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.peoplePanel = "connect";
      state.inviteShare = null;
      renderPeople();
    });
  });

  root.querySelectorAll("[data-people-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.peoplePanel = "list";
      state.inviteShare = null;
      renderPeople();
    });
  });

  root.querySelectorAll("[data-create-invite]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void createInviteFlow(btn);
    });
  });

  root.querySelectorAll("[data-copy-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = state.inviteShare?.joinCommand ?? "";
      try {
        await navigator.clipboard.writeText(text);
        setFlash(
          "Invite copied. Send it to your teammate, then clear this screen when done.",
          "info"
        );
      } catch {
        setFlash(
          "Could not copy automatically — select the invite text and copy it manually.",
          "error"
        );
      }
    });
  });

  root.querySelectorAll("[data-clear-invite]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.inviteShare = null;
      state.peoplePanel = "list";
      renderPeople();
    });
  });

  root.querySelectorAll("[data-join-invite]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void joinInviteFlow(btn);
    });
  });

  root.querySelectorAll("[data-people-remove-start]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.peoplePanel = "remove";
      renderPeople();
      const confirmBtn = viewPeople.querySelector("[data-people-remove-confirm]");
      confirmBtn?.focus();
    });
  });

  root.querySelectorAll("[data-people-remove-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.peoplePanel = "list";
      renderPeople();
    });
  });

  if (state.peoplePanel === "remove") {
    const onKey = (event) => {
      if (event.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        state.peoplePanel = "list";
        renderPeople();
      }
    };
    document.addEventListener("keydown", onKey);
  }

  root.querySelectorAll("[data-people-remove-confirm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void removePersonFlow(btn);
    });
  });

  root.querySelectorAll('input[type="radio"][data-cap]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      void savePermissionFlow(input);
    });
  });
}

async function createInviteFlow(button) {
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const invite = await api(`${API_PREFIX}/invite`, { method: "POST", body: "{}" });
    state.inviteShare = buildInviteShareModel(invite);
    // Do not put invite secret in URL/history.
    renderPeople();
    setFlash("Invite created. Copy it and send it privately.", "info");
  } catch (error) {
    setFlash(humanizeLoadError(error instanceof Error ? error.message : String(error)), "error");
    button.disabled = false;
    button.textContent = "Create invite";
  }
}

async function joinInviteFlow(button) {
  const input = document.getElementById("join-invite-input");
  const statusEl = document.getElementById("join-status");
  const raw = String(input?.value ?? "").trim();
  if (!raw) {
    if (statusEl) statusEl.textContent = "Paste an invite first.";
    return;
  }
  button.disabled = true;
  button.textContent = "Connecting…";
  if (statusEl) statusEl.textContent = "Connecting…";
  try {
    await api(`${API_PREFIX}/join`, {
      method: "POST",
      body: JSON.stringify({ joinCommand: raw })
    });
    if (input) input.value = "";
    state.inviteShare = null;
    state.peoplePanel = "list";
    await loadPeers();
    await loadStatus();
    const newest = buildPeopleListModel(state.peers).people.at(-1);
    if (newest) {
      state.selectedPersonId = newest.participantId;
      persistViewInUrl("people", state.selectedPersonId);
    }
    renderPeople();
    updateShellChrome();
    setFlash(
      newest
        ? `Connected to ${newest.name}. Review what they can ask your agent to do.`
        : "Connected. Review permissions for your new collaborator.",
      "info"
    );
  } catch (error) {
    const message = humanizeJoinError(error instanceof Error ? error.message : String(error));
    if (statusEl) statusEl.textContent = message;
    setFlash(message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
}

async function savePermissionFlow(input) {
  const capabilityId = input.getAttribute("data-cap");
  const peerRef = input.getAttribute("data-peer");
  const policy = input.value;
  if (!capabilityId || !peerRef || !policy) return;

  if (isAllowSessionForbidden(capabilityId, policy)) {
    setFlash(
      "Apply approved code changes cannot be set to Allow. Every change still needs Approve once.",
      "error"
    );
    await loadPeers();
    renderPeople();
    return;
  }

  const block = input.closest("[data-cap-block]");
  const statusEl = block?.querySelector("[data-perm-status]");
  const previousPeer = findPeerBySelection(state.peers, state.selectedPersonId);
  state.permissionBusy = `${peerRef}:${capabilityId}`;
  if (statusEl) statusEl.textContent = "Saving…";
  input
    .closest(".policy-group")
    ?.querySelectorAll("input")
    .forEach((el) => {
      el.disabled = true;
    });

  try {
    await api(
      `${API_PREFIX}/peers/${encodeURIComponent(peerRef)}/capabilities/${encodeURIComponent(capabilityId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ policy })
      }
    );
    await loadPeers();
    state.permissionBusy = null;
    renderPeople();
    if (statusEl) {
      // re-query after re-render
    }
    setFlash("Permission updated.", "info");
  } catch (error) {
    state.permissionBusy = null;
    await loadPeers();
    renderPeople();
    setFlash(
      humanizePermissionError(error instanceof Error ? error.message : String(error)),
      "error"
    );
    // Ensure UI shows previous authoritative state
    if (previousPeer) {
      state.selectedPersonId = previousPeer.participantId;
    }
  }
}

async function removePersonFlow(button) {
  const peerRef = button.getAttribute("data-peer");
  if (!peerRef) return;
  button.disabled = true;
  try {
    await api(`${API_PREFIX}/peers/${encodeURIComponent(peerRef)}/remove`, {
      method: "POST",
      body: "{}"
    });
    state.selectedPersonId = null;
    state.peoplePanel = "list";
    sessionStorage.removeItem("arokoSelectedPerson");
    await loadPeers();
    persistViewInUrl("people", null);
    renderPeople();
    setFlash("Removed from this session.", "info");
  } catch (error) {
    setFlash(humanizeRemoveError(error instanceof Error ? error.message : String(error)), "error");
    state.peoplePanel = "list";
    renderPeople();
  }
}

function renderSettings() {
  if (state.loadingSettings && !state.settingsModel) {
    viewSettings.innerHTML = `<div class="state-block" data-tone="loading">Loading settings…</div>`;
    return;
  }
  if (!state.settingsModel) {
    viewSettings.innerHTML = `<div class="state-block" data-tone="error">Aroko couldn't load Settings. Check that the local runtime is running, then try again.</div>`;
    return;
  }

  if (state.settingsPanel === "leave-confirm" && state.settingsModel.leave.available) {
    const copy = state.settingsModel.leave.copy;
    viewSettings.innerHTML = `
      <div class="settings-leave-confirm home-card">
        <h2>${escapeHtml(copy.title)}</h2>
        <p class="subtle">${escapeHtml(copy.body)}</p>
        <div class="actions-row">
          <button type="button" class="danger-btn" data-settings-leave="confirm" ${state.leavingSession ? "disabled" : ""}>${escapeHtml(copy.confirm)}</button>
          <button type="button" class="ghost-btn" data-settings-leave="cancel" ${state.leavingSession ? "disabled" : ""}>${escapeHtml(copy.cancel)}</button>
        </div>
      </div>`;
    bindSettingsInteractions(viewSettings);
    return;
  }

  const m = state.settingsModel;
  const agent = m.agent;
  const notif = m.notifications;

  const notifActions =
    notif.primaryAction === "enable"
      ? `<button type="button" class="ghost-btn" data-settings-notify="enable">Enable notifications</button>`
      : notif.primaryAction === "open_settings"
        ? `<button type="button" class="ghost-btn" data-settings-notify="open_settings">Open notification settings</button>`
        : "";

  const advancedRows = m.advanced
    .map(
      (row) => `
      <div class="settings-kv">
        <span class="settings-k">${escapeHtml(row.label)}</span>
        <span class="settings-v">${escapeHtml(row.value)}</span>
      </div>`
    )
    .join("");

  const html = `
    <div class="settings-grid">
      <section class="home-card settings-card" aria-labelledby="settings-agent-heading">
        <h2 id="settings-agent-heading">Your agent</h2>
        <div class="settings-row">
          <p class="settings-primary">${escapeHtml(agent.displayName)}</p>
          <span class="status-pill" data-tone="${escapeHtml(agent.health.tone)}">${escapeHtml(agent.health.label)}</span>
        </div>
        ${agent.agentName ? `<p class="subtle">${escapeHtml(agent.agentName)}</p>` : ""}
        ${agent.health.detail ? `<p class="subtle">${escapeHtml(agent.health.detail)}</p>` : ""}
        <p class="subtle settings-hint">${escapeHtml(agent.changeHint.message)}</p>
        <p class="settings-cli-hint"><code>${escapeHtml(agent.changeHint.command)}</code></p>
      </section>

      <section class="home-card settings-card" aria-labelledby="settings-project-heading">
        <h2 id="settings-project-heading">Project</h2>
        <p class="settings-primary">${escapeHtml(m.project.label)}</p>
        ${m.project.cliHint ? `<p class="subtle">Project setup uses the CLI:</p><p class="settings-cli-hint"><code>${escapeHtml(m.project.cliHint)}</code></p>` : `<p class="subtle">Project changes are currently made from the Aroko CLI.</p>`}
      </section>

      <section class="home-card settings-card" aria-labelledby="settings-notify-heading">
        <h2 id="settings-notify-heading">Notifications</h2>
        <div class="settings-row">
          <span class="status-pill" data-tone="${escapeHtml(notif.tone)}">${escapeHtml(notif.label)}</span>
        </div>
        ${notif.detail ? `<p class="subtle">${escapeHtml(notif.detail)}</p>` : ""}
        ${notifActions ? `<div class="settings-inline-actions">${notifActions}</div>` : ""}
      </section>

      <section class="home-card settings-card" aria-labelledby="settings-connection-heading">
        <h2 id="settings-connection-heading">Connection</h2>
        <div class="settings-row">
          <p class="settings-primary">${escapeHtml(m.connection.label)}</p>
          <span class="status-pill" data-tone="${escapeHtml(m.connection.tone)}">${escapeHtml(m.connection.label)}</span>
        </div>
        ${m.connection.helper ? `<p class="subtle">${escapeHtml(m.connection.helper)}</p>` : ""}
      </section>

      <section class="home-card settings-card" aria-labelledby="settings-about-heading">
        <h2 id="settings-about-heading">About</h2>
        <p class="settings-primary">${escapeHtml(m.about.productName)}</p>
        <p class="subtle">${escapeHtml(m.about.versionLine)}</p>
        ${m.about.buildLine ? `<p class="subtle">${escapeHtml(m.about.buildLine)}</p>` : ""}
        <div class="settings-updates" data-tone="${escapeHtml(m.updates.tone)}">
          <p class="settings-updates-head">${escapeHtml(m.updates.headline)}</p>
          <p class="subtle">${escapeHtml(m.updates.body)}</p>
        </div>
      </section>

      <section class="home-card settings-card settings-advanced" aria-labelledby="settings-advanced-heading">
        <h2 id="settings-advanced-heading">Advanced</h2>
        <p class="subtle">Technical diagnostics for troubleshooting. Normal use doesn't require these details.</p>
        <div class="settings-kv-list" role="list">${advancedRows}</div>
        <div class="settings-inline-actions">
          <button type="button" class="ghost-btn" data-settings-copy-diagnostics>Copy diagnostics</button>
        </div>
      </section>

      ${
        m.leave.available
          ? `<section class="home-card settings-card settings-danger" aria-labelledby="settings-session-heading">
        <h2 id="settings-session-heading">Session</h2>
        <p class="subtle">Leave clears this machine's local session. Collaborators won't reach you here until you connect again.</p>
        <button type="button" class="danger-btn" data-settings-leave="prompt">Leave session</button>
      </section>`
          : ""
      }
    </div>`;

  if (settingsHtmlContainsForbiddenTech(html)) {
    viewSettings.innerHTML = `<div class="state-block" data-tone="error">Settings refused to render technical details.</div>`;
    return;
  }
  viewSettings.innerHTML = html;
  bindSettingsInteractions(viewSettings);
}

function bindSettingsInteractions(root) {
  root.querySelectorAll("[data-settings-leave]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-settings-leave");
      if (action === "prompt") {
        state.settingsPanel = "leave-confirm";
        renderSettings();
        return;
      }
      if (action === "cancel") {
        state.settingsPanel = "main";
        renderSettings();
        return;
      }
      if (action === "confirm") {
        void confirmLeaveSession();
      }
    });
  });

  root.querySelectorAll("[data-settings-notify]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-settings-notify");
      void handleSettingsNotificationAction(action);
    });
  });

  const copyBtn = root.querySelector("[data-settings-copy-diagnostics]");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      void copyDiagnostics();
    });
  }
}

async function handleSettingsNotificationAction(action) {
  try {
    if (action === "enable") {
      state.notify = await api(`${API_PREFIX}/notifications/enable`, {
        method: "POST",
        body: "{}"
      });
    } else if (action === "open_settings") {
      state.notify = await api(`${API_PREFIX}/notifications/open-settings`, {
        method: "POST",
        body: "{}"
      });
    }
    renderNotifyBanner();
    await loadSettings();
    renderSettings();
  } catch (error) {
    setFlash("Aroko couldn't update notification settings right now.", "error");
    console.error(error);
  }
}

async function copyDiagnostics() {
  const summary = state.settingsModel?.diagnostics;
  if (!summary?.safe || !summary.text) {
    setFlash("Diagnostics aren't available to copy right now.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(summary.text);
    setFlash("Diagnostics copied.", "info");
  } catch {
    setFlash("Couldn't copy diagnostics — your browser may block clipboard access.", "error");
  }
}

async function confirmLeaveSession() {
  if (state.leavingSession) return;
  state.leavingSession = true;
  renderSettings();
  try {
    await api(`${API_PREFIX}/leave`, { method: "POST", body: "{}" });
    state.settingsPanel = "main";
    state.leavingSession = false;
    setFlash("You left this session on this machine.", "info");
    await refresh();
    void setView("home");
  } catch (error) {
    state.leavingSession = false;
    setFlash(
      error instanceof Error && error.message
        ? `Aroko couldn't leave the session. ${error.message}`
        : "Aroko couldn't leave the session right now.",
      "error"
    );
    renderSettings();
  }
}

function renderNotifyBanner() {
  const snap = state.notify;
  if (!snap || !snap.shouldPrompt) {
    notifyBanner.classList.add("hidden");
    return;
  }
  notifyBanner.classList.remove("hidden");
  notifyBanner.dataset.auth = snap.authorization ?? "";
  notifyHeadline.textContent = snap.headline ?? "Enable notifications";
  notifyBody.textContent =
    snap.body ?? "Enable notifications so you know when a collaborator needs your approval.";
  if (snap.primaryAction === "open_settings") {
    notifyPrimary.textContent = "Open Notification Settings";
    notifyPrimary.disabled = !snap.canOpenSettings;
  } else if (snap.primaryAction === "enable") {
    notifyPrimary.textContent = "Enable Notifications";
    notifyPrimary.disabled = !snap.canRequestPermission;
  } else {
    notifyPrimary.textContent = "OK";
    notifyPrimary.disabled = true;
  }
}

async function onNotifyPrimary() {
  const snap = state.notify;
  if (!snap) return;
  notifyPrimary.disabled = true;
  try {
    if (snap.primaryAction === "open_settings") {
      state.notify = await api(`${API_PREFIX}/notifications/open-settings`, {
        method: "POST",
        body: "{}"
      });
    } else if (snap.primaryAction === "enable") {
      state.notify = await api(`${API_PREFIX}/notifications/enable`, {
        method: "POST",
        body: "{}"
      });
    }
    renderNotifyBanner();
  } catch (error) {
    console.error(error);
    notifyPrimary.disabled = false;
  }
}

async function onNotifyDismiss() {
  try {
    state.notify = await api(`${API_PREFIX}/notifications/dismiss`, {
      method: "POST",
      body: "{}"
    });
    renderNotifyBanner();
  } catch (error) {
    console.error(error);
  }
}

async function loadWorkFeed() {
  if (state.view === "history") {
    const [actionsRes, inspectionsRes, tasksRes] = await Promise.all([
      api(`${API_PREFIX}/actions?filter=recent&limit=50`),
      api(`${API_PREFIX}/inspections?filter=recent&limit=50`),
      api(`${API_PREFIX}/tasks?filter=recent&limit=50`).catch(() => ({ tasks: [] }))
    ]);
    state.actions = actionsRes.actions ?? [];
    state.activeInspections = inspectionsRes.inspections ?? [];
    state.collaborativeTasks = tasksRes.tasks ?? [];
    state.workItems = mergeHistoryItems({
      actions: state.actions,
      inspections: state.activeInspections,
      tasks: state.collaborativeTasks
    }).filter((item) => historyCategoryFilter(item, state.historyFilter));
  } else if (state.view === "live") {
    const [actionsRes, inspectionsRes, tasksRes] = await Promise.all([
      api(`${API_PREFIX}/actions?filter=active&limit=50`),
      api(`${API_PREFIX}/inspections?filter=active&limit=50`),
      api(`${API_PREFIX}/tasks?filter=active&limit=50`).catch(() => ({ tasks: [] }))
    ]);
    state.actions = actionsRes.actions ?? [];
    state.activeInspections = inspectionsRes.inspections ?? [];
    state.collaborativeTasks = tasksRes.tasks ?? [];
    state.workItems = mergeLiveWorkItems({
      actions: state.actions,
      inspections: state.activeInspections,
      tasks: state.collaborativeTasks
    });
  } else if (state.view === "needs-you") {
    const [actionsRes, permissionsRes, inputsRes] = await Promise.all([
      api(`${API_PREFIX}/actions?filter=pending&limit=50`),
      api(`${API_PREFIX}/permissions`),
      api(`${API_PREFIX}/tasks/pending-inputs`).catch(() => ({ inputs: [] }))
    ]);
    state.actions = actionsRes.actions ?? [];
    state.pendingPermissions = permissionsRes.pending ?? [];
    state.pendingInputs = inputsRes.inputs ?? [];
    state.workItems = mergeNeedsYouItems({
      actions: state.actions,
      permissions: state.pendingPermissions,
      pendingInputs: state.pendingInputs
    });
  } else {
    state.actions = [];
    state.workItems = [];
  }

  if (state.selectedKind && state.selectedId) {
    const finder = state.view === "history" ? findHistoryItem : findWorkItem;
    const still = finder(state.workItems, state.selectedKind, state.selectedId);
    if (still) {
      state.selectedWork = still;
      state.selectedAction = still.kind === "action" ? still : null;
      await renderWorkDetail(still);
    } else {
      try {
        const detail = await fetchWorkDetail(state.selectedKind, state.selectedId);
        state.selectedWork = detail;
        state.selectedAction = detail?.kind === "action" ? detail : null;
        await renderWorkDetail(detail);
      } catch {
        state.selectedWork = null;
        state.selectedAction = null;
        state.selectedKind = null;
        state.selectedId = null;
      }
    }
  }
}

async function fetchWorkDetail(kind, id) {
  if (kind === "inspection") {
    const detail = await api(`${API_PREFIX}/inspections/${encodeURIComponent(id)}`);
    return {
      ...detail,
      kind: "inspection",
      id: detail.requestId,
      workKey: workItemKey("inspection", detail.requestId),
      actionLabel: detail.actionLabel ?? "Inspection"
    };
  }
  if (kind === "permission") {
    const data = await api(`${API_PREFIX}/permissions`);
    const pending = (data.pending ?? []).find((p) => p.permissionRequestId === id);
    if (!pending) {
      throw new Error("permission_not_found");
    }
    return {
      ...pending,
      kind: "permission",
      id: pending.permissionRequestId,
      workKey: workItemKey("permission", pending.permissionRequestId)
    };
  }
  if (kind === "collaborative_task") {
    const path =
      state.view === "history"
        ? `${API_PREFIX}/tasks/${encodeURIComponent(id)}/history`
        : `${API_PREFIX}/tasks/${encodeURIComponent(id)}`;
    const detail = await api(path);
    return {
      ...detail,
      kind: "collaborative_task",
      id: detail.taskId ?? id,
      workKey: workItemKey("collaborative_task", detail.taskId ?? id)
    };
  }
  if (kind === "input_request") {
    const data = await api(`${API_PREFIX}/tasks/pending-inputs`).catch(() => ({ inputs: [] }));
    const pending = (data.inputs ?? []).find((p) => p.inputRequestId === id);
    if (!pending) {
      throw new Error("input_request_not_found");
    }
    return {
      ...pending,
      kind: "input_request",
      id: pending.inputRequestId,
      workKey: workItemKey("input_request", pending.inputRequestId),
      interaction: "answer",
      collaborativeInteraction: "answer"
    };
  }
  const detail = await api(`${API_PREFIX}/actions/${encodeURIComponent(id)}`);
  return {
    ...detail,
    kind: "action",
    id: detail.actionId,
    workKey: workItemKey("action", detail.actionId)
  };
}

function renderHistoryFilterBar() {
  const filters = [
    { id: "all", label: "All" },
    { id: "question", label: "Questions" },
    { id: "change", label: "Changes" },
    { id: "tests", label: "Tests" }
  ];
  return `<div class="history-filter-bar" role="toolbar" aria-label="Filter history">
    ${filters
      .map(
        (f) =>
          `<button type="button" class="ghost-btn history-filter-btn${state.historyFilter === f.id ? " active" : ""}" data-history-filter="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`
      )
      .join("")}
  </div>`;
}

function renderList() {
  const items = state.workItems;
  listMeta.textContent = `${workListLabel(state.view)} · ${items.length} item(s)`;
  if (items.length === 0) {
    if (state.view === "live") {
      const empty = buildLiveEmptyCopy();
      actionList.innerHTML = `<li class="empty-state"><p>${empty.title}</p><p class="subtle">${empty.detail}</p></li>`;
      return;
    }
    if (state.view === "history") {
      const empty = buildHistoryEmptyCopy();
      actionList.innerHTML = `${renderHistoryFilterBar()}<li class="empty-state"><p>${empty.title}</p><p class="subtle">${empty.detail}</p><p class="subtle">${empty.retention}</p></li>`;
      bindHistoryFilterButtons(actionList);
      return;
    }
    const empty =
      state.view === "needs-you" ? "You're all caught up." : "No recent completed work yet.";
    actionList.innerHTML = `<li class="empty-state">${empty}</li>`;
    return;
  }

  const fallbackProvider =
    formatProviderDisplayName(state.status?.codingAgent?.provider) ?? "your coding agent";

  if (state.view === "history") {
    const groups = groupHistoryItems(items);
    actionList.innerHTML =
      renderHistoryFilterBar() +
      groups
        .map(
          (group) => `
      <li class="history-group" aria-hidden="false">
        <h3 class="history-group-title">${escapeHtml(group.label)}</h3>
        <ul class="history-group-list">
          ${group.items
            .map((item) => {
              const selected =
                item.kind === state.selectedKind && item.id === state.selectedId ? "selected" : "";
              const card = sanitizeHistoryCardModel(buildHistoryCardModel(item));
              const cardHtml = `
            <li class="action-item ${selected}" data-work-kind="${escapeHtml(item.kind)}" data-work-id="${escapeHtml(item.id)}" tabindex="0" role="button">
              <h3>${escapeHtml(card.headline)}</h3>
              <p class="subtle">${escapeHtml(card.question)}</p>
              <div class="meta">
                ${statusBadge(item.status)}
                <span>${escapeHtml(card.workType)}</span>
                <span>${escapeHtml(card.statusLine)}</span>
                ${card.decisionHint ? `<span>${escapeHtml(card.decisionHint)}</span>` : ""}
              </div>
              <p class="subtle history-when">${escapeHtml(card.whenLabel)}</p>
            </li>`;
              // Per-item fail-closed: if a card still trips the filter, replace only that card.
              if (historyHtmlContainsForbiddenTech(cardHtml)) {
                return `
            <li class="action-item ${selected}" data-work-kind="${escapeHtml(item.kind)}" data-work-id="${escapeHtml(item.id)}" tabindex="0" role="button">
              <h3>History item</h3>
              <p class="subtle">Technical detail hidden for safety.</p>
            </li>`;
              }
              return cardHtml;
            })
            .join("")}
        </ul>
      </li>`
        )
        .join("");
        bindHistoryFilterButtons(actionList);
    bindWorkListItems(actionList);
    return;
  }

  actionList.innerHTML = items
    .map((item) => {
      const selected =
        item.kind === state.selectedKind && item.id === state.selectedId ? "selected" : "";
      if (state.view === "live" || item.kind === "inspection") {
        const card = buildLiveCardModel(item, { fallbackProvider });
        const liveHint = card.live
          ? `<span class="live-dot" title="Updating live">Live</span>`
          : "";
        return `
        <li class="action-item ${selected}" data-work-kind="${escapeHtml(item.kind)}" data-work-id="${escapeHtml(item.id)}" tabindex="0" role="button">
          <h3>${escapeHtml(card.headline)} ${liveHint}</h3>
          <p class="subtle">${escapeHtml(card.question)}</p>
          <div class="meta">
            ${statusBadge(item.status)}
            <span>${escapeHtml(card.workType)}</span>
            <span>${escapeHtml(card.recentActivity)}</span>
            <span>${escapeHtml(card.elapsedLabel)}</span>
          </div>
        </li>`;
      }
      if (item.kind === "permission") {
        const card = buildNeedsYouCardModel(item);
        return `
        <li class="action-item ${selected}" data-work-kind="permission" data-work-id="${escapeHtml(item.id)}" tabindex="0" role="button">
          <h3>${escapeHtml(card.title)}</h3>
          <p class="subtle">${escapeHtml(card.subtitle)}</p>
          <div class="meta">
            ${statusBadge(item.status)}
            <span>${escapeHtml(card.cta)}</span>
          </div>
        </li>`;
      }
      if (item.kind === "input_request") {
        const card = buildNeedsYouCardModel(item);
        return `
        <li class="action-item ${selected}" data-work-kind="input_request" data-work-id="${escapeHtml(item.id)}" tabindex="0" role="button">
          <h3>${escapeHtml(card?.title ?? "Answer needed")}</h3>
          <p class="subtle">${escapeHtml(card?.subtitle ?? "")}</p>
          <div class="meta">
            ${statusBadge(item.status ?? "pending")}
            <span>${escapeHtml(card?.cta ?? "Answer")}</span>
          </div>
        </li>`;
      }
      const card = buildNeedsYouCardModel(item);
      const summary = item.requestSummary ?? item.summary ?? item.actionLabel;
      const provenance =
        typeof item.collaborativeProvenanceLabel === "string" &&
        item.collaborativeProvenanceLabel.trim()
          ? `<p class="subtle">${escapeHtml(item.collaborativeProvenanceLabel.trim())}</p>`
          : card?.provenance
            ? `<p class="subtle">${escapeHtml(card.provenance)}</p>`
            : "";
      const provider = item.providerDisplayName
        ? `<span>${escapeHtml(item.providerDisplayName)}</span>`
        : "";
      return `
        <li class="action-item ${selected}" data-work-kind="action" data-work-id="${escapeHtml(item.id)}" tabindex="0" role="button">
          <h3>${escapeHtml(card?.title ?? peerLabel(item))}</h3>
          <p class="subtle">${escapeHtml(summary ?? "")}</p>
          ${provenance}
          <div class="meta">
            ${statusBadge(item.status)}
            <span>${escapeHtml(item.actionLabel ?? "Request")}</span>
            ${provider}
            <span>${escapeHtml(coarseStateLabel(item))}</span>
            <span>${formatAge(item.updatedAt)}</span>
          </div>
        </li>`;
    })
    .join("");

  if (liveHtmlContainsForbiddenTech(actionList.innerHTML)) {
    actionList.innerHTML = `<li class="empty-state">Aroko refused to render technical connection details.</li>`;
    return;
  }

  bindWorkListItems(actionList);
}

function bindHistoryFilterButtons(root) {
  root.querySelectorAll("[data-history-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.getAttribute("data-history-filter") ?? "all";
      state.historyFilter = filter;
      void loadWorkFeed().then(() => renderList());
    });
  });
}

function bindWorkListItems(root) {
  root.querySelectorAll(".action-item").forEach((el) => {
    const activate = () => {
      const kind = el.getAttribute("data-work-kind");
      const id = el.getAttribute("data-work-id");
      if (kind && id) void selectWork(kind, id);
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

async function selectWork(kind, id) {
  state.selectedKind = kind;
  state.selectedId = id;
  detailPanel.classList.remove("hidden");
  layoutEl.classList.add("has-detail");
  renderList();
  const item = findWorkItem(state.workItems, kind, id);
  if (item) {
    state.selectedWork = item;
    state.selectedAction = kind === "action" ? item : null;
    await renderWorkDetail(item);
    detailPanel.focus?.();
    return;
  }
  const detail = await fetchWorkDetail(kind, id);
  state.selectedWork = detail;
  state.selectedAction = kind === "action" ? detail : null;
  await renderWorkDetail(detail);
}

function closeDetail() {
  state.selectedId = null;
  state.selectedKind = null;
  state.selectedWork = null;
  state.selectedAction = null;
  state.deciding = false;
  detailPanel.classList.add("hidden");
  layoutEl?.classList.remove("has-detail");
  if (isWorkView(state.view)) {
    renderList();
  }
}

function renderActivityTimeline(progress) {
  const timeline = prepareProgressTimeline(progress);
  if (timeline.length === 0) {
    return `<p class="subtle">No progress recorded yet.</p>`;
  }
  return `<ol class="activity-timeline">${timeline
    .map((event, index) => {
      const label = formatActivityLabel(event);
      const chips = formatApprovedMetadataChips(event.safeMetadata)
        .filter((chip) => {
          if (chip.key === "path" && label.includes(chip.label)) return false;
          if (chip.key === "query" && label.includes(chip.label)) return false;
          if (chip.key === "tool" && label.includes(chip.label)) return false;
          return true;
        })
        .map(
          (chip) =>
            `<span class="activity-chip">${escapeHtml(chip.key)}: ${escapeHtml(chip.label)}</span>`
        )
        .join("");
      const isLast = index === timeline.length - 1;
      return `
        <li class="activity-step${isLast ? " current" : ""}">
          <div class="activity-rail" aria-hidden="true">
            <span class="activity-dot"></span>
            ${isLast ? "" : `<span class="activity-line"></span>`}
          </div>
          <div class="activity-body">
            <div class="activity-label">${escapeHtml(label)}</div>
            ${chips ? `<div class="activity-chips">${chips}</div>` : ""}
            <div class="subtle">${formatAge(event.timestamp)}</div>
          </div>
        </li>`;
    })
    .join("")}</ol>`;
}

async function openReview(actionId) {
  await setView("needs-you", {
    selectWorkKind: "action",
    selectWorkId: actionId,
    keepDetail: true
  });
}

async function renderWorkDetail(item) {
  if (!item) {
    detailContent.innerHTML = `<p class="subtle">Select an item to see details.</p>`;
    return;
  }
  if (state.view === "history") {
    await renderHistoryDetail(item);
    return;
  }
  if (item.kind === "permission") {
    await renderPermissionDetail(item);
    return;
  }
  if (item.kind === "inspection") {
    await renderInspectionDetail(item);
    return;
  }
  if (item.kind === "collaborative_task") {
    await renderCollaborativeTaskDetail(item);
    return;
  }
  if (item.kind === "input_request") {
    await renderInputRequestDetail(item);
    return;
  }
  await renderActionDetail(item);
}

async function renderHistoryDetail(item) {
  let detailItem = item;
  if (item.kind === "collaborative_task" && !Array.isArray(item.timeline)) {
    try {
      detailItem = await fetchWorkDetail("collaborative_task", item.id ?? item.taskId);
    } catch {
      detailItem = item;
    }
  }
  const sections = sanitizeHistoryDetailSections(buildHistoryDetailSections(detailItem));
  const taskTimeline = Array.isArray(sections.timelineLabels) ? sections.timelineLabels : null;
  const progressHtml = taskTimeline
    ? taskTimeline.length
      ? `<ol class="activity-timeline">${taskTimeline
          .map(
            (label) =>
              `<li class="activity-item"><div class="activity-label">${escapeHtml(label)}</div></li>`
          )
          .join("")}</ol>`
      : `<p class="subtle">No timeline events recorded.</p>`
    : renderActivityTimeline(detailItem.progress ?? []);
  let proposalHtml = "";
  if (
    detailItem.kind === "action" &&
    (detailItem.actionType === "repository.edit" ||
      detailItem.actionType === "change.propose" ||
      detailItem.artifactRefs?.length)
  ) {
    try {
      const proposal = await api(
        `${API_PREFIX}/actions/${encodeURIComponent(detailItem.actionId)}/proposal`
      );
      proposalHtml = `
        <div class="detail-section">
          <h3>Change</h3>
          <p>${escapeHtml(proposal.summary)}</p>
          <p class="subtle">${proposal.stats.filesChanged} file(s) · +${proposal.stats.additions} / −${proposal.stats.deletions}</p>
          ${
            detailItem.actionType === "repository.edit"
              ? `<p class="subtle">This is the exact change that was reviewed. Aroko applies only the approved MODIFY / CREATE / DELETE / RENAME operations.</p>
                 ${formatLifecycleOpList(proposal.unifiedDiff)}`
              : `<p class="subtle">Proposal only — applying a change requires separate approval.</p>
                 ${formatLifecycleOpList(proposal.unifiedDiff)}`
          }
          <div class="diff-box" role="region" aria-label="Historical diff (read only)">${formatDiff(proposal.unifiedDiff)}</div>
        </div>`;
    } catch {
      proposalHtml = `<p class="subtle">Change details are no longer available for this record.</p>`;
    }
  }
  const decisionHtml = sections.decision
    ? `<div class="detail-section"><h3>Decision</h3><p>${escapeHtml(sections.decision)}</p></div>`
    : "";
  const testsHtml = sections.tests
    ? `<div class="detail-section"><h3>Tests</h3><p>${escapeHtml(sections.tests)}</p></div>`
    : "";
  const resultHtml =
    sections.result || sections.error
      ? `<div class="detail-section"><h3>Result</h3>${
          sections.result ? `<p>${escapeHtml(sections.result)}</p>` : ""
        }${sections.error ? `<p class="error">${escapeHtml(sections.error)}</p>` : ""}</div>`
      : "";
  const agentLine = sections.providerUnavailable
    ? `<p class="subtle">${escapeHtml(sections.provider)}</p>`
    : `<p>${escapeHtml(sections.provider)}</p>`;
  const whenLine = [
    sections.whenLabel,
    sections.durationLabel ? `Completed in ${sections.durationLabel}` : null,
    sections.status
  ]
    .filter(Boolean)
    .join(" · ");
  const requestHeading = detailItem.kind === "collaborative_task" ? "Goal" : "Request";
  const html = `
    <h2>${escapeHtml(sections.who)}</h2>
    <div class="detail-section">
      <h3>${requestHeading}</h3>
      <p class="question-block">${escapeHtml(sections.request)}</p>
    </div>
    <div class="detail-section">
      <h3>Agent</h3>
      ${agentLine}
    </div>
    <div class="detail-section">
      <h3>When</h3>
      <p>${escapeHtml(whenLine)}</p>
    </div>
    <div class="detail-section">
      <h3>Activity</h3>
      ${progressHtml}
    </div>
    ${resultHtml}
    ${proposalHtml}
    ${decisionHtml}
    ${testsHtml}
    <details class="technical-details">
      <summary>Technical details</summary>
      <dl class="technical-dl">
        <dt>Record</dt><dd>${escapeHtml(String(sections.technical.kind ?? ""))}</dd>
        <dt>ID</dt><dd><code>${escapeHtml(String(sections.technical.id ?? ""))}</code></dd>
        <dt>Status</dt><dd>${escapeHtml(String(sections.technical.status ?? ""))}</dd>
        ${sections.technical.createdAt ? `<dt>Created</dt><dd>${escapeHtml(sections.technical.createdAt)}</dd>` : ""}
        ${sections.technical.completedAt ? `<dt>Completed</dt><dd>${escapeHtml(sections.technical.completedAt)}</dd>` : ""}
      </dl>
    </details>
    <p class="subtle">${escapeHtml(buildHistoryEmptyCopy().retention)}</p>
  `;
  if (historyHtmlContainsForbiddenTech(html)) {
    detailContent.innerHTML = `<p class="error">Technical detail hidden for safety.</p>`;
    return;
  }
  detailContent.innerHTML = html;
}

async function renderInspectionDetail(inspection) {
  const fallbackProvider =
    formatProviderDisplayName(state.status?.codingAgent?.provider) ?? "Coding agent";
  const card = buildLiveCardModel(inspection, { fallbackProvider });
  const who = card.who;
  const provider = card.provider;
  const service =
    typeof inspection.peer?.service === "string" && inspection.peer.service.trim()
      ? inspection.peer.service.trim()
      : null;
  const started = inspection.createdAt
    ? new Date(inspection.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const progressHtml = renderActivityTimeline(inspection.progress ?? []);
  const result =
    inspection.terminal && (inspection.summary || inspection.message)
      ? `<div class="detail-section"><h3>Result</h3><p>${escapeHtml(inspection.summary ?? inspection.message)}</p></div>`
      : "";
  const html = `
    <h2>${escapeHtml(who)} asked</h2>
    <p class="question-block">${escapeHtml(card.question)}</p>
    <div class="meta">
      ${statusBadge(inspection.status)}
      <span>${escapeHtml(provider)}</span>
      ${service ? `<span>${escapeHtml(service)}</span>` : ""}
      ${started ? `<span>Started ${escapeHtml(started)}</span>` : ""}
      <span>${escapeHtml(card.elapsedLabel)}</span>
    </div>
    <p class="subtle live-caption">Live timeline · updates while active</p>
    <div class="detail-section">
      <h3>Activity</h3>
      ${progressHtml}
    </div>
    ${result}
  `;
  if (liveHtmlContainsForbiddenTech(html)) {
    detailContent.innerHTML = `<p class="error">Aroko refused to render unsafe technical detail.</p>`;
    return;
  }
  detailContent.innerHTML = html;
}

async function renderCollaborativeTaskDetail(task) {
  const fallbackProvider =
    formatProviderDisplayName(state.status?.codingAgent?.provider) ?? "Coding agent";
  const card = buildLiveCardModel({ ...task, kind: "collaborative_task" }, { fallbackProvider });
  const waiting =
    typeof task.waitingOnLabel === "string" && task.waitingOnLabel.trim()
      ? task.waitingOnLabel.trim()
      : card?.recentActivity;
  const html = `
    <h2>${escapeHtml(card?.headline ?? "Goal")}</h2>
    <p class="question-block">${escapeHtml(card?.question ?? "")}</p>
    <div class="meta">
      ${statusBadge(task.status)}
      <span>${escapeHtml(card?.workType ?? "Goal")}</span>
      <span>${escapeHtml(card?.elapsedLabel ?? card?.statusLabel ?? "")}</span>
    </div>
    ${waiting ? `<p class="subtle">Waiting on: ${escapeHtml(waiting)}</p>` : ""}
    <p class="subtle live-caption">Task progress · separate from route health</p>
    ${task.ownerWaitSummary ? `<p class="subtle">${escapeHtml(task.ownerWaitSummary)}</p>` : ""}
    <p class="subtle">Approvals for linked commands appear under Needs you. This goal card does not approve.</p>
  `;
  if (liveHtmlContainsForbiddenTech(html)) {
    detailContent.innerHTML = `<p class="error">Aroko refused to render unsafe technical detail.</p>`;
    return;
  }
  detailContent.innerHTML = html;
}

async function renderInputRequestDetail(pending) {
  const card = buildNeedsYouCardModel({ ...pending, kind: "input_request" });
  const busy = state.deciding;
  const cliHint = card?.cliHint
    ? `<p class="subtle settings-cli-hint"><code>${escapeHtml(card.cliHint)}</code></p>`
    : "";
  detailContent.innerHTML = `
    <h2>${escapeHtml(card?.title ?? "Answer needed")}</h2>
    <p class="subtle">${escapeHtml(card?.helper ?? "Answer this question to continue the goal.")}</p>
    <div class="detail-section">
      <h3>Question</h3>
      <p class="question-block">${escapeHtml(card?.question ?? pending.question ?? "")}</p>
    </div>
    <div class="meta">
      ${statusBadge(pending.status ?? "pending")}
      <span>Answer</span>
    </div>
    <label class="subtle" for="input-request-answer">Your answer</label>
    <textarea id="input-request-answer" class="answer-input" rows="4" ${busy ? "disabled" : ""} placeholder="Type your answer"></textarea>
    <div class="actions-row">
      <button type="button" class="primary-btn" data-input-answer="1" ${busy ? "disabled" : ""}>Answer</button>
    </div>
    ${cliHint}
    <p class="subtle">This is an Answer — not Approve or Deny. Owner command approvals stay on Action cards.</p>
  `;
  const answerBtn = detailContent.querySelector("[data-input-answer]");
  answerBtn?.addEventListener("click", async () => {
    if (state.deciding) return;
    const textarea = detailContent.querySelector("#input-request-answer");
    const answer = String(textarea?.value ?? "").trim();
    if (!answer) {
      setFlash("Enter an answer before submitting.", "error");
      return;
    }
    state.deciding = true;
    try {
      await api(
        `${API_PREFIX}/tasks/inputs/${encodeURIComponent(pending.id ?? pending.inputRequestId)}/answer`,
        {
          method: "POST",
          body: JSON.stringify({
            answer,
            ...(pending.taskId ? { taskId: pending.taskId } : {})
          })
        }
      );
      setFlash("Answer sent.", "ok");
      await loadWorkFeed();
      renderList();
      const refreshed = findWorkItem(
        state.workItems,
        "input_request",
        pending.id ?? pending.inputRequestId
      );
      if (refreshed) {
        await renderWorkDetail(refreshed);
      } else {
        closeDetail();
      }
    } catch (error) {
      setFlash(
        humanizeDecisionError(error instanceof Error ? error.message : String(error)),
        "error"
      );
      await loadWorkFeed();
      renderList();
    } finally {
      state.deciding = false;
    }
  });
}

async function renderPermissionDetail(pending) {
  const card = buildNeedsYouCardModel(pending);
  const copy = capabilityApprovalCopy(pending.capabilityId);
  const expiresHint = pending.expiresAt
    ? `<p class="subtle">Approval window ends ${escapeHtml(new Date(pending.expiresAt).toLocaleString())}.</p>`
    : "";
  const busy = state.deciding;
  detailContent.innerHTML = `
    <h2>${escapeHtml(card.title)}</h2>
    <p class="subtle">${escapeHtml(copy.helper)}</p>
    <div class="meta">
      ${statusBadge(pending.status)}
      <span>Permission request</span>
    </div>
    <div class="actions-row">
      <button type="button" class="primary-btn" data-perm-decide="allow-once" ${busy ? "disabled" : ""}>${escapeHtml(card.allowOnceLabel)}</button>
      <button type="button" class="danger-btn" data-perm-decide="deny" ${busy ? "disabled" : ""}>${escapeHtml(card.denyLabel)}</button>
    </div>
    ${expiresHint}
    <p class="subtle">Persistent access still lives under People. This decision covers this request only.</p>
  `;
  detailContent.querySelectorAll("[data-perm-decide]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const decision = btn.getAttribute("data-perm-decide");
      if (!decision || state.deciding) return;
      if (
        decision === "allow-session" &&
        (pending.capabilityId === "repository.edit" ||
          pending.actionType === "repository.edit" ||
          pending.capabilityId === "process.execute" ||
          pending.actionType === "process.execute")
      ) {
        setFlash("This permission only supports Approve once / Ask me each time.", "error");
        return;
      }
      state.deciding = true;
      detailContent.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
      });
      try {
        await api(
          `${API_PREFIX}/permissions/${encodeURIComponent(pending.permissionRequestId)}/decide`,
          {
            method: "POST",
            body: JSON.stringify({ decision })
          }
        );
        const flash = humanizeDecisionSuccess(decision, {
          status: decision === "deny" ? "denied" : "approved"
        });
        setFlash(flash.message, flash.tone);
        closeDetail();
        await loadWorkFeed();
        renderList();
      } catch (error) {
        setFlash(
          humanizeDecisionError(error instanceof Error ? error.message : String(error)),
          "error"
        );
        state.deciding = false;
        await loadWorkFeed();
        renderList();
        const refreshed = findWorkItem(state.workItems, "permission", pending.permissionRequestId);
        if (refreshed) {
          await renderPermissionDetail(refreshed);
        } else {
          closeDetail();
        }
      } finally {
        state.deciding = false;
      }
    });
  });
}

async function renderActionDetail(action) {
  const summary = action.requestSummary ?? action.summary ?? action.actionLabel;
  const providerName =
    action.providerDisplayName ??
    formatProviderDisplayName(state.status?.codingAgent?.provider) ??
    "Coding agent";
  const onLiveTab = state.view === "live";
  const needsCard = buildNeedsYouCardModel({ ...action, kind: "action" });

  let proposalHtml = "";
  const showProposal =
    state.view === "needs-you" ||
    action.status === "approval_required" ||
    (!onLiveTab &&
      (action.actionType === "repository.edit" ||
        action.actionType === "change.propose" ||
        (action.artifactRefs?.length && action.actionType !== "process.execute")));

  let processHtml = "";
  if (action.actionType === "process.execute" && !onLiveTab) {
    const proc = action.processExecution;
    if (!proc || action.processApprovalDisplayUnavailable || action.approvalUnavailableReason) {
      processHtml = `
      <section class="proposal-panel">
        <h3>Command</h3>
        <p class="flash error">${escapeHtml(
          action.approvalUnavailableReason ||
            "Unable to display command details. Approval unavailable."
        )}</p>
        <p class="subtle">Aroko will not offer Approve once until the exact command can be shown.</p>
      </section>
    `;
    } else {
      const exe = escapeHtml(String(proc.executable ?? ""));
      const args = Array.isArray(proc.args)
        ? proc.args.map((a) => `<li><code>${escapeHtml(String(a))}</code></li>`).join("")
        : "";
      const cwd = escapeHtml(String(proc.cwd ?? "."));
      const timeoutMs = Number(proc.timeoutMs);
      const timeout =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs % 60000 === 0 && timeoutMs >= 60000
            ? `${timeoutMs / 60000} minute${timeoutMs / 60000 === 1 ? "" : "s"}`
            : timeoutMs % 1000 === 0
              ? `${timeoutMs / 1000} second${timeoutMs / 1000 === 1 ? "" : "s"}`
              : `${timeoutMs} ms`
          : "—";
      const display = escapeHtml(String(proc.commandDisplay ?? ""));
      processHtml = `
      <section class="proposal-panel">
        <h3>Command</h3>
        <pre class="diff-block">${display}</pre>
        <p><strong>Executable</strong> <code>${exe}</code></p>
        <p><strong>Arguments</strong> <span class="subtle">(exact argv — not a shell string)</span></p>
        <ul>${args || "<li><em>(none)</em></li>"}</ul>
        <p><strong>Working directory</strong> <code>${cwd}</code></p>
        <p><strong>Timeout</strong> ${escapeHtml(String(timeout))}</p>
        <p class="subtle">This command runs with your user privileges and may modify files, your repository, machine state, or external services.</p>
      </section>
    `;
    }
  }

  if (showProposal && !onLiveTab && action.actionType !== "process.execute") {
    try {
      const proposal = await api(
        `${API_PREFIX}/actions/${encodeURIComponent(action.actionId)}/proposal`
      );
      const proposalProvider =
        formatProviderDisplayName(proposal.provider?.id) ?? action.providerDisplayName;
      const editNotes =
        action.actionType === "repository.edit"
          ? `<p class="subtle">If you approve, Aroko applies this exact reviewed change once (MODIFY / CREATE / DELETE / RENAME).</p>
             ${formatLifecycleOpList(proposal.unifiedDiff)}`
          : action.actionType === "change.propose"
            ? `<p class="subtle">This is a proposal only — it does not change your repository by itself.</p>
               ${formatLifecycleOpList(proposal.unifiedDiff)}`
            : "";
      proposalHtml = `
        <div class="detail-section">
          <h3>Proposed change</h3>
          <p>${escapeHtml(proposal.summary)}</p>
          <p class="subtle">${proposal.stats.filesChanged} file(s) · +${proposal.stats.additions} / −${proposal.stats.deletions}${proposalProvider ? ` · ${escapeHtml(proposalProvider)}` : ""}</p>
          ${editNotes}
          <div class="diff-box" role="region" aria-label="Exact proposed diff">${formatDiff(proposal.unifiedDiff)}</div>
        </div>`;
    } catch {
      proposalHtml = `<p class="subtle">Proposal preview not available for this request.</p>`;
    }
  }

  const progressHtml = renderActivityTimeline(action.progress ?? []);

  let actionsHtml = "";
  if (onLiveTab) {
    if (isActionReviewable(action)) {
      actionsHtml = `
        <div class="actions-row">
          <button type="button" class="primary-btn" data-review="1">Review →</button>
        </div>
        <p class="subtle">Opens Needs you for exact-diff Approve once / Deny. Live does not approve.</p>`;
    }
  } else if (action.status === "approval_required" && action.needsApproval) {
    const approveOnce = action.canApproveOnce;
    const approveSession =
      action.canApproveSession &&
      !approveOnce &&
      action.actionType !== "repository.edit" &&
      action.capabilityId !== "repository.edit" &&
      action.actionType !== "process.execute" &&
      action.capabilityId !== "process.execute";
    const expiresHint = action.expiresAt
      ? `<p class="subtle">Approval window ends ${escapeHtml(new Date(action.expiresAt).toLocaleString())}.</p>`
      : "";
    const editHint =
      action.actionType === "repository.edit"
        ? `<p class="subtle">Approve once applies this exact change. There is no approve-forever or Allow for session for edits.</p>`
        : action.actionType === "process.execute"
          ? `<p class="subtle">${escapeHtml(
              action.approvalUnavailableReason ||
                needsCard?.helper ||
                "Approve once runs this exact command. There is no Allow for session."
            )}</p>`
          : needsCard?.helper
            ? `<p class="subtle">${escapeHtml(needsCard.helper)}</p>`
            : "";
    const busy = state.deciding;
    const processApproveBlocked =
      action.actionType === "process.execute" &&
      (!action.processExecution ||
        action.processApprovalDisplayUnavailable ||
        Boolean(action.approvalUnavailableReason) ||
        !approveOnce);
    actionsHtml = `
      <div class="actions-row">
        ${
          approveOnce && !processApproveBlocked
            ? `<button type="button" class="primary-btn" data-decide="allow-once" ${busy ? "disabled" : ""}>${escapeHtml(needsCard?.allowOnceLabel ?? "Approve once")}</button>`
            : action.actionType === "process.execute"
              ? `<p class="flash error">Approve once unavailable — command details missing.</p>`
              : ""
        }
        ${approveSession ? `<button type="button" class="ghost-btn" data-decide="allow-session" ${busy ? "disabled" : ""}>Allow for this session</button>` : ""}
        <button type="button" class="danger-btn" data-decide="deny" ${busy ? "disabled" : ""}>Deny</button>
      </div>
      ${editHint}
      ${expiresHint}`;
  } else if (action.status === "expired") {
    actionsHtml = `<p class="error">Expired — not applied. Ask them to send a fresh request.</p>`;
  }

  const html = `
    <h2>${escapeHtml(peerLabel(action))}</h2>
    <p class="subtle">${escapeHtml(summary ?? "")}</p>
    ${
      typeof action.collaborativeProvenanceLabel === "string" &&
      action.collaborativeProvenanceLabel.trim()
        ? `<p class="subtle">${escapeHtml(action.collaborativeProvenanceLabel.trim())}</p>`
        : needsCard?.provenance
          ? `<p class="subtle">${escapeHtml(needsCard.provenance)}</p>`
          : ""
    }
    <div class="meta">
      ${statusBadge(action.status)}
      <span>${escapeHtml(action.actionLabel)}</span>
      <span>${escapeHtml(providerName)}</span>
      <span>${escapeHtml(coarseStateLabel(action))}</span>
    </div>
    ${
      onLiveTab
        ? `<p class="subtle live-caption">Live timeline · updates while active · no manual refresh</p>`
        : ""
    }
    <div class="detail-section">
      <h3>Activity</h3>
      ${progressHtml}
    </div>
    ${proposalHtml}
    ${processHtml}
    ${actionsHtml}
  `;
  if (liveHtmlContainsForbiddenTech(html)) {
    detailContent.innerHTML = `<p class="error">Aroko refused to render unsafe technical detail.</p>`;
    return;
  }
  detailContent.innerHTML = html;

  detailContent.querySelectorAll("[data-review]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void openReview(action.actionId);
    });
  });

  detailContent.querySelectorAll("[data-decide]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const decision = btn.getAttribute("data-decide");
      if (!decision || state.deciding) return;
      if (
        decision === "allow-session" &&
        (action.actionType === "repository.edit" ||
          action.capabilityId === "repository.edit" ||
          action.actionType === "process.execute" ||
          action.capabilityId === "process.execute")
      ) {
        setFlash("This action only supports Approve once.", "error");
        return;
      }
      if (
        decision === "allow-once" &&
        action.actionType === "process.execute" &&
        (!action.processExecution ||
          action.processApprovalDisplayUnavailable ||
          action.approvalUnavailableReason)
      ) {
        setFlash("Unable to display command details. Approval unavailable.", "error");
        return;
      }
      state.deciding = true;
      detailContent.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
      });
      try {
        const result = await api(
          `${API_PREFIX}/actions/${encodeURIComponent(action.actionId)}/decide`,
          {
            method: "POST",
            body: JSON.stringify({ decision })
          }
        );
        const flash = humanizeDecisionSuccess(decision, result);
        setFlash(flash.message, flash.tone);
        closeDetail();
        await loadWorkFeed();
        renderList();
      } catch (error) {
        setFlash(
          humanizeDecisionError(error instanceof Error ? error.message : String(error)),
          "error"
        );
        state.deciding = false;
        await loadWorkFeed();
        renderList();
        const refreshed = findWorkItem(state.workItems, "action", action.actionId);
        if (refreshed) {
          await renderActionDetail(refreshed);
        } else {
          closeDetail();
        }
      } finally {
        state.deciding = false;
      }
    });
  });
}

function formatLifecycleOpList(unifiedDiff) {
  const ops = summarizeLifecycleOps(unifiedDiff);
  if (ops.length === 0) {
    return "";
  }
  const items = ops
    .map((op) => {
      if (op.kind === "create") {
        return `<li><strong>NEW FILE</strong> ${escapeHtml(op.path)}</li>`;
      }
      if (op.kind === "delete") {
        return `<li><strong>DELETED</strong> ${escapeHtml(op.path)}</li>`;
      }
      if (op.kind === "rename") {
        return `<li><strong>RENAMED</strong> ${escapeHtml(op.source)} → ${escapeHtml(op.dest)}</li>`;
      }
      return `<li><strong>MODIFIED</strong> ${escapeHtml(op.path)}</li>`;
    })
    .join("");
  return `<ul class="lifecycle-ops" aria-label="Filesystem operations">${items}</ul>`;
}

function summarizeLifecycleOps(unifiedDiff) {
  if (!unifiedDiff) {
    return [];
  }
  const ops = [];
  const lines = String(unifiedDiff).replace(/\r\n/g, "\n").split("\n");
  let gitA;
  let gitB;
  let renameFrom;
  let renameTo;
  let minus;
  for (const line of lines) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      gitA = git[1];
      gitB = git[2];
      renameFrom = undefined;
      renameTo = undefined;
      minus = undefined;
      continue;
    }
    if (line.startsWith("rename from ")) {
      renameFrom = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("--- ")) {
      minus = line.slice(4).trim().split("\t")[0] ?? "";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const plus = line.slice(4).trim().split("\t")[0] ?? "";
      if (minus === "/dev/null") {
        ops.push({ kind: "create", path: plus.replace(/^b\//, "") });
      } else if (plus === "/dev/null") {
        ops.push({
          kind: "delete",
          path: (minus || "").replace(/^a\//, "") || gitA
        });
      } else if ((renameFrom && renameTo) || (gitA && gitB && gitA !== gitB)) {
        ops.push({
          kind: "rename",
          source: renameFrom || gitA,
          dest: renameTo || gitB || plus.replace(/^b\//, "")
        });
      } else {
        ops.push({ kind: "modify", path: plus.replace(/^b\//, "") || gitB || gitA });
      }
    }
  }
  return ops;
}

function formatDiff(diff) {
  if (!diff) return "";
  return diff
    .split("\n")
    .map((line) => {
      let cls = "";
      let meaning = "";
      if (line.startsWith("+") && !line.startsWith("+++")) {
        cls = "add";
        meaning = ' data-diff="added" aria-label="added line"';
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        cls = "del";
        meaning = ' data-diff="removed" aria-label="removed line"';
      }
      // Preserve exact proposal text (including leading +/−) for hash-bound review.
      return `<div class="diff-line ${cls}"${meaning}>${escapeHtml(line)}</div>`;
    })
    .join("");
}

async function refresh() {
  await loadStatus();
  await loadRelayStatus();
  updateShellChrome();
  await loadNotificationStatus();
  if (state.view === "home") {
    await loadHome();
    renderHome();
  } else if (state.view === "people") {
    await loadPeers();
    renderPeople();
  } else if (state.view === "settings") {
    await loadSettings();
    renderSettings();
  } else if (isWorkView(state.view)) {
    await loadWorkFeed();
    renderList();
  }
}

function restartPolling() {
  startPolling();
}

function startPolling() {
  stopPolling();
  const tick = () => {
    refresh()
      .catch(() => undefined)
      .finally(() => {
        const ms = resolveLivePollIntervalMs({
          view: state.view,
          tab: state.view,
          liveItems: state.view === "live" ? state.workItems : [],
          actions: state.actions,
          selectedAction: state.selectedAction
        });
        state.pollTimer = window.setTimeout(tick, ms);
      });
  };
  const initial = resolveLivePollIntervalMs({
    view: state.view,
    tab: state.view,
    liveItems: state.view === "live" ? state.workItems : [],
    actions: state.actions,
    selectedAction: state.selectedAction
  });
  state.pollTimer = window.setTimeout(tick, initial);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function bindUi() {
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view") ?? "home";
      void setView(view);
    });
  });

  document.getElementById("detail-close").addEventListener("click", closeDetail);
  notifyPrimary.addEventListener("click", () => {
    void onNotifyPrimary();
  });
  notifyDismiss.addEventListener("click", () => {
    void onNotifyDismiss();
  });

  window.addEventListener("hashchange", () => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    if (params.get("token")) {
      bootstrapDeepLink();
      return;
    }
    const view = params.get("view");
    const person = params.get("person");
    if (view) {
      const normalized = normalizeControlCenterView(view);
      if (normalized !== state.view || (person && person !== state.selectedPersonId)) {
        void setView(normalized, {
          skipUrl: true,
          ...(person ? { personId: person } : {})
        });
      }
    }
  });

  const tokenInput = document.getElementById("token-input");
  const tokenSubmit = document.getElementById("token-submit");

  async function connectWithToken() {
    const token = normalizeControlToken(tokenInput.value);
    if (!token) {
      showAuth("Paste the control token from aroko control status --show-token.");
      return;
    }
    tokenInput.value = "";
    sessionStorage.setItem("pairmeshControlToken", token);
    state.token = token;
    tokenSubmit.disabled = true;
    tokenSubmit.textContent = "Opening…";
    try {
      await loadStatus();
      showApp();
      await setView(state.view || "home");
      startPolling();
    } catch (error) {
      sessionStorage.removeItem("pairmeshControlToken");
      state.token = "";
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        message.includes("401") || message.toLowerCase().includes("unauthorized")
          ? "Wrong or stale token (tokens change after aroko restart). Run aroko control status --show-token again, or use aroko open."
          : humanizeLoadError(message);
      showAuth(hint);
    } finally {
      tokenSubmit.disabled = false;
      tokenSubmit.textContent = "Open Aroko";
    }
  }

  tokenSubmit.addEventListener("click", () => {
    void connectWithToken();
  });
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void connectWithToken();
    }
  });
}

async function init() {
  state.baseUrl = window.location.origin;
  state.token = bootstrapDeepLink();
  bindUi();

  const deepView =
    sessionStorage.getItem("pairmeshDeepLinkView") ||
    sessionStorage.getItem("arokoControlView") ||
    "home";
  const deepAction = sessionStorage.getItem("pairmeshDeepLinkAction");
  const deepPerson = sessionStorage.getItem("arokoSelectedPerson");
  sessionStorage.removeItem("pairmeshDeepLinkView");
  sessionStorage.removeItem("pairmeshDeepLinkAction");

  state.view = normalizeControlCenterView(deepView);
  if (deepPerson) {
    state.selectedPersonId = deepPerson;
  }

  try {
    if (sessionStorage.getItem("pairmeshControlExchangeCode")) {
      await redeemExchangeCodeIfNeeded();
    }
  } catch (error) {
    showAuth(
      humanizeLoadError(error instanceof Error ? error.message : "Exchange code failed")
    );
    return;
  }

  if (state.token) {
    try {
      await loadStatus();
      showApp();
      if (deepAction) {
        await setView("needs-you", { selectActionId: deepAction, keepDetail: true });
      } else {
        await setView(state.view, {
          ...(state.view === "people" && state.selectedPersonId
            ? { personId: state.selectedPersonId }
            : {})
        });
      }
      startPolling();
    } catch (error) {
      showAuth(humanizeLoadError(error instanceof Error ? error.message : String(error)));
    }
  } else {
    showAuth();
  }
}

void init();

export const __pairmeshActivityUi = {
  ACTIVITY_POLL_MS,
  formatActivityLabel,
  prepareProgressTimeline,
  resolveLivePollIntervalMs
};

export const __arokoControlCenter = {
  normalizeControlCenterView,
  buildHomeModel,
  homeHtmlContainsForbiddenTech,
  buildPeopleListModel,
  buildPersonDetailModel,
  isAllowSessionForbidden,
  mergeLiveWorkItems,
  mergeNeedsYouItems,
  mergeHistoryItems,
  buildLiveCardModel,
  buildNeedsYouCardModel,
  buildHistoryCardModel
};
