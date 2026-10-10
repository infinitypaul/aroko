import { describe, expect, it } from "vitest";
import {
  actionListFilterForView,
  buildHomeModel,
  buildOnboardingModel,
  buildYourAgentCard,
  homeHtmlContainsForbiddenTech,
  mapPeerConnectionLabel,
  mapRuntimeConnectionLabel,
  normalizeControlCenterView,
  summarizeNeedsYouAction
} from "../../control-web/home-present.js";

describe("Stage 20 Prompt 2 — Control Center home presentation", () => {
  it("normalizes legacy deep-link views to product views", () => {
    expect(normalizeControlCenterView("inbox")).toBe("needs-you");
    expect(normalizeControlCenterView("activity")).toBe("live");
    expect(normalizeControlCenterView("history")).toBe("history");
    expect(normalizeControlCenterView("home")).toBe("home");
    expect(normalizeControlCenterView("needs-you")).toBe("needs-you");
    expect(normalizeControlCenterView("unknown")).toBe("home");
  });

  it("maps action list filters for work views", () => {
    expect(actionListFilterForView("needs-you")).toBe("pending");
    expect(actionListFilterForView("inbox")).toBe("pending");
    expect(actionListFilterForView("live")).toBe("active");
    expect(actionListFilterForView("activity")).toBe("active");
    expect(actionListFilterForView("history")).toBe("recent");
    expect(actionListFilterForView("home")).toBeNull();
  });

  it("builds Home with peers, active work, and needs-you", () => {
    const model = buildHomeModel({
      status: {
        runtime: { running: true, agentName: "payment-service-agent" },
        session: { present: true, status: "active", localAgent: "payment-service-agent" },
        codingAgent: { provider: "claude-code" },
        projectId: "prj_demo",
        workspace: "/Users/secret/Sites/payment-service"
      },
      peers: [
        {
          peer: "kelvin-agent",
          participantId: "peer_k",
          displayName: "Kelvin",
          service: "payment-service",
          connectivity: "ready",
          agent: "ready",
          relationship: "paired",
          grants: []
        },
        {
          peer: "sarah-agent",
          participantId: "peer_s",
          displayName: "Sarah",
          connectivity: "reconnecting",
          agent: "unknown",
          relationship: "paired",
          grants: []
        }
      ],
      activeInspections: [
        {
          requestId: "req_1",
          question: "Where is payment retry handled?",
          peer: { displayName: "Kelvin" },
          status: "running"
        }
      ],
      activeActions: [
        {
          actionId: "act_1",
          actionType: "change.propose",
          actionLabel: "Change proposal",
          status: "executing",
          peer: { displayName: "Sarah" },
          requestSummary: "Fix retry reference"
        }
      ],
      pendingActions: [
        {
          actionId: "act_2",
          actionType: "repository.edit",
          actionLabel: "Apply change",
          status: "approval_required",
          peer: { displayName: "Sarah" }
        }
      ],
      pendingPermissions: []
    });

    expect(model.connection.label).toBe("Connected");
    expect(model.yourAgent.provider).toBe("Claude Code");
    expect(model.yourAgent.agentName).toBe("payment-service-agent");
    expect(JSON.stringify(model)).not.toMatch(/\/Users\/secret/);
    expect(model.people[0]?.name).toBe("Kelvin");
    expect(model.people[0]?.connection.label).toBe("Ready");
    expect(model.people[1]?.connection.label).toBe("Connecting…");
    expect(model.active[0]?.title).toContain("Kelvin");
    expect(model.active[0]?.title).toContain("payment retry");
    expect(model.needsYou[0]?.title).toContain("apply a proposed change");
    expect(model.emptyPeople).toBe(false);
    expect(model.emptyActive).toBe(false);
    expect(model.emptyNeedsYou).toBe(false);
  });

  it("renders intentional empty states", () => {
    const model = buildHomeModel({
      status: { runtime: { running: true }, session: { present: false } },
      peers: [],
      activeActions: [],
      activeInspections: [],
      pendingActions: [],
      pendingPermissions: []
    });
    expect(model.emptyPeople).toBe(true);
    expect(model.emptyActive).toBe(true);
    expect(model.emptyNeedsYou).toBe(true);
    expect(model.connection.label).toBe("Connected");
  });

  it("maps temporarily unreachable peers without technical URLs", () => {
    const label = mapPeerConnectionLabel({
      connectivity: "unknown",
      agent: "unavailable",
      agentUrl: "http://127.0.0.1:47202",
      displayName: "Kelvin"
    });
    expect(label.label).toBe("Temporarily unreachable");
    expect(JSON.stringify(label)).not.toMatch(/127\.0\.0\.1/);
    expect(JSON.stringify(label)).not.toMatch(/agentUrl/);
  });

  it("never treats absolute workspace path as project label", () => {
    const card = buildYourAgentCard({
      codingAgent: { provider: "cursor" },
      session: { localAgent: "paul-agent" },
      workspace: "/Users/paul/Sites/pairmesh"
    });
    expect(card.provider).toBe("Cursor Agent");
    expect(card.projectLabel).toBeNull();
    expect(card.hasAbsoluteWorkspace).toBe(true);
  });

  it("flags forbidden technical tokens in Home HTML", () => {
    expect(homeHtmlContainsForbiddenTech("<div>Connected</div>")).toBe(false);
    expect(homeHtmlContainsForbiddenTech("<div>connectionId=abc</div>")).toBe(true);
    expect(homeHtmlContainsForbiddenTech("<div>A2A agent</div>")).toBe(true);
    expect(homeHtmlContainsForbiddenTech("<div>MCP tool</div>")).toBe(true);
    expect(homeHtmlContainsForbiddenTech("<div>http://127.0.0.1:47202</div>")).toBe(true);
  });

  it("repository.edit needs-you copy stays Approve-once oriented", () => {
    const item = summarizeNeedsYouAction({
      actionType: "repository.edit",
      peer: { displayName: "Paul" }
    });
    expect(item.title).toContain("apply a proposed change");
    expect(item.cta).toBe("Review");
  });

  it("maps stopped runtime to Not connected", () => {
    expect(mapRuntimeConnectionLabel({ runtime: { running: false } }).label).toBe("Not connected");
  });

  it("maps relay reconnecting for shell connection", () => {
    expect(
      mapRuntimeConnectionLabel(
        { runtime: { running: true }, session: { present: true } },
        { mode: "relay", lifecycle: "reconnecting" }
      ).label
    ).toBe("Reconnecting…");
  });

  it("onboarding guides ready zero-peer state toward Connect", () => {
    const onboarding = buildOnboardingModel(
      {
        runtime: { running: true },
        codingAgent: { provider: "claude-code" },
        projectId: "prj_demo"
      },
      0
    );
    expect(onboarding.show).toBe(true);
    expect(onboarding.headline).toMatch(/ready/i);
    expect(onboarding.cta).toBe("Connect someone");
  });

  it("onboarding shows missing provider CLI hint", () => {
    const onboarding = buildOnboardingModel({ runtime: { running: true } }, 0);
    expect(onboarding.kind).toBe("provider");
    expect(onboarding.cliHint).toContain("codingAgent.provider");
  });

  it("onboarding hides when peers exist", () => {
    const onboarding = buildOnboardingModel(
      {
        runtime: { running: true },
        codingAgent: { provider: "claude-code" },
        projectId: "prj_demo"
      },
      2
    );
    expect(onboarding.show).toBe(false);
  });

  it("buildHomeModel includes onboarding state", () => {
    const model = buildHomeModel({
      status: {
        runtime: { running: true },
        codingAgent: { provider: "claude-code" },
        projectId: "prj_demo"
      },
      peers: [],
      activeActions: [],
      activeInspections: [],
      pendingActions: [],
      pendingPermissions: []
    });
    expect(model.onboarding?.show).toBe(true);
    expect(model.onboarding?.cta).toBe("Connect someone");
  });
});
