import { describe, expect, it } from "vitest";
import {
  buildAdvancedDiagnostics,
  buildSafeDiagnosticSummary,
  buildSettingsModel,
  buildUpdatesSection,
  diagnosticObjectContainsSecrets,
  formatAboutVersion,
  leaveSessionCopy,
  mapNotificationSettingsLabel,
  mapProviderHealth,
  mapSettingsConnectionLabel,
  resolveProjectDisplay,
  settingsHtmlContainsForbiddenTech
} from "../../control-web/settings-present.js";

const readyStatus = {
  version: "0.1.0-alpha.7",
  buildId: "20260901T120000Z",
  buildTimestamp: "2026-09-01T12:00:00.000Z",
  projectId: "prj_demo",
  runtime: { running: true, idle: true },
  session: { present: true, status: "active", sessionCode: "PM-ABC123", peerCount: 1 },
  codingAgent: { provider: "claude-code" }
};

const relayReady = {
  mode: "relay",
  lifecycle: "ready",
  role: "creator",
  peerReady: true,
  relayWsUrl: "wss://relay.aroko.dev/"
};

describe("Stage 20 Prompt 6 — Settings presentation", () => {
  it("maps provider health without fabricating auth", () => {
    expect(mapProviderHealth(readyStatus).label).toBe("Ready");
    expect(mapProviderHealth({ runtime: { running: true } }).label).toBe("Not configured");
    expect(
      mapProviderHealth({ codingAgent: { provider: "cursor" }, runtime: { running: false } }).label
    ).toBe("Unavailable");
  });

  it("shows safe project label without absolute paths", () => {
    const project = resolveProjectDisplay({
      ...readyStatus,
      workspace: "/Users/secret/Sites/demo"
    });
    expect(project.label).toBe("prj_demo");
    expect(project.configured).toBe(true);
    expect(JSON.stringify(project)).not.toMatch(/\/Users\/secret/);
  });

  it("maps notifications to human On/Off/permission states", () => {
    expect(mapNotificationSettingsLabel({ authorization: "authorized" }).label).toBe("On");
    expect(
      mapNotificationSettingsLabel({ authorization: "not_determined", canRequestPermission: true })
        .label
    ).toBe("Off");
    expect(
      mapNotificationSettingsLabel({ authorization: "denied", canOpenSettings: true }).label
    ).toBe("Needs browser permission");
  });

  it("separates normal connection from relay lifecycle in Advanced", () => {
    expect(mapSettingsConnectionLabel(readyStatus, relayReady).label).toBe("Connected");
    expect(
      mapSettingsConnectionLabel(readyStatus, { mode: "relay", lifecycle: "reconnecting" }).label
    ).toBe("Reconnecting…");
    const advanced = buildAdvancedDiagnostics(readyStatus, relayReady, 2);
    expect(advanced.some((row) => row.label === "Relay URL")).toBe(true);
    expect(advanced.some((row) => row.label === "Relay state")).toBe(true);
  });

  it("shows version/build and honest update placeholder", () => {
    const about = formatAboutVersion(readyStatus);
    expect(about.productName).toBe("Aroko");
    expect(about.versionLine).toContain("0.1.0-alpha.7");
    expect(about.buildLine).toContain("20260901T120000Z");
    expect(buildUpdatesSection(readyStatus).body).toMatch(/isn't available yet/i);
    expect(
      buildUpdatesSection({ deferredRestart: { pending: true, targetBuildId: "20260902" } })
        .headline
    ).toBe("Restart required");
  });

  it("builds settings model with agent change CLI honesty", () => {
    const model = buildSettingsModel({
      status: readyStatus,
      relay: relayReady,
      notify: { authorization: "authorized" },
      peerCount: 1
    });
    expect(model.agent.displayName).toBe("Claude Code");
    expect(model.agent.changeHint.command).toContain("codingAgent.provider");
    expect(model.leave.available).toBe(true);
    expect(model.diagnostics.safe).toBe(true);
  });

  it("copy diagnostics excludes secrets", () => {
    const summary = buildSafeDiagnosticSummary({
      status: readyStatus,
      relay: relayReady,
      peerCount: 1
    });
    expect(summary.safe).toBe(true);
    expect(summary.text).toContain("Aroko diagnostics");
    expect(summary.text).not.toContain("Claude Code");
    expect(summary.text).toContain("claude-code");
    expect(summary.text).not.toMatch(/Bearer|invite|secret|token/i);
    expect(diagnosticObjectContainsSecrets({ token: "abc" })).toBe(true);
    expect(diagnosticObjectContainsSecrets({ providerId: "claude-code" })).toBe(false);
  });

  it("leave copy explains session consequence honestly", () => {
    const copy = leaveSessionCopy();
    expect(copy.body).toMatch(/local session/i);
    expect(copy.body).toMatch(/history/i);
  });

  it("flags forbidden technical tokens in Settings HTML", () => {
    expect(settingsHtmlContainsForbiddenTech("<div>Connected</div>")).toBe(false);
    expect(settingsHtmlContainsForbiddenTech("<div>allow_session</div>")).toBe(true);
    expect(settingsHtmlContainsForbiddenTech("<div>Bearer abc</div>")).toBe(true);
  });
});
