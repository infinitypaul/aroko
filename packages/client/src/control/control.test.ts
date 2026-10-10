import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlHttpClient,
  ControlPlane,
  LocalStateStore,
  SessionManager,
  generateControlToken,
  resolveInviteInitialGrants,
  startControlHttpServer,
  writeRuntimeInfo,
  type ControlHttpServer
} from "../index.js";

describe("Control HTTP API", () => {
  const servers: ControlHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  async function startPlane(workspace?: string) {
    const root = await mkdtemp(join(tmpdir(), "pairmesh-control-"));
    const stateFilePath = join(root, "state.json");
    const stateStore = new LocalStateStore({ stateFilePath });
    const manager = new SessionManager({
      stateStore,
      skipPeerHealthPreflight: true
    });
    const plane = new ControlPlane({
      sessionManager: manager,
      ...(workspace ? { workspace } : { workspace: root })
    });
    const token = generateControlToken();
    const server = await startControlHttpServer({
      controlPlane: plane,
      controlToken: token
    });
    servers.push(server);
    const client = new ControlHttpClient({
      baseUrl: server.baseUrl,
      controlToken: token
    });
    return { root, manager, stateStore, plane, token, server, client };
  }

  it("binds loopback only and requires bearer auth", async () => {
    const { server, token } = await startPlane();
    expect(server.host).toBe("127.0.0.1");
    expect(server.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);

    const unauth = await fetch(`${server.baseUrl}/control/v1/status`);
    expect(unauth.status).toBe(401);

    const bad = await fetch(`${server.baseUrl}/control/v1/status`, {
      headers: { Authorization: "Bearer wrong-token-value-xxxxxxxx" }
    });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${server.baseUrl}/control/v1/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      runtime: { running: boolean };
      session: { present: boolean };
    };
    expect(body.session.present).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/controlToken/i);
    expect(JSON.stringify(body)).not.toMatch(/inviteSecret/i);
  });

  it("creates invite with customized Stage 10 policies and stores them on the invite record", async () => {
    const { manager, client, stateStore } = await startPlane();
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const invite = await client.createInvite({
      initialGrants: [
        { capabilityId: "repository.inspect", policy: "approval_required" },
        { capabilityId: "repository.source_references", policy: "deny" }
      ]
    });

    expect(invite.joinCommand).toContain("aroko join");
    expect(invite.inviteSecret).toBeTruthy();
    expect(invite.initialGrants).toEqual(
      resolveInviteInitialGrants([
        { capabilityId: "repository.inspect", policy: "approval_required" },
        { capabilityId: "repository.source_references", policy: "deny" }
      ])
    );

    const state = await stateStore.load();
    const record = state?.sessionSecurity?.invites.at(-1);
    expect(record?.initialGrants).toEqual([
      { capabilityId: "repository.inspect", policy: "approval_required" },
      { capabilityId: "repository.source_references", policy: "deny" }
    ]);
    expect(JSON.stringify(record)).not.toMatch(invite.inviteSecret);
  });

  it("omits secrets from status/permissions/audit reads", async () => {
    const { manager, client, root } = await startPlane();
    await writeRuntimeInfo(root, {
      pid: process.pid,
      port: 47101,
      baseUrl: "http://127.0.0.1:47101",
      agentName: "paul-agent",
      startedAt: new Date().toISOString(),
      controlUrl: "http://127.0.0.1:9",
      controlToken: "must-not-leak-into-control-dtos"
    });

    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const status = await client.getStatus();
    const permissions = await client.getPermissions();
    const audit = await client.listAudit(20);
    const blob = JSON.stringify({ status, permissions, audit });
    expect(blob).not.toMatch(/must-not-leak/);
    expect(blob).not.toMatch(/controlToken/);
    expect(blob).not.toMatch(/inviteSecret/);
    expect(blob).not.toMatch(/secretHash/);
    expect(status.runtime.controlUrl).toBe("http://127.0.0.1:9");
  });

  it("sanitized Control DTO snapshots never include controlToken", async () => {
    const { client, manager } = await startPlane();
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });
    const [status, permissions, capabilities, audit] = await Promise.all([
      client.getStatus(),
      client.getPermissions(),
      client.listCapabilities(),
      client.listAudit(10)
    ]);
    const sanitizedSnapshot = { status, permissions, capabilities, audit };
    expect(JSON.stringify(sanitizedSnapshot)).not.toMatch(/controlToken/i);
  });

  it("supports leave via control mutations", async () => {
    const { manager, client, stateStore } = await startPlane();
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });
    await client.leave();
    const state = await stateStore.load();
    expect(state).toBeNull();
  });
  it("lists pending actions over Control HTTP when approval_required", async () => {
    const { manager, client, stateStore, server } = await startPlane();
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const empty = await client.listPendingActions();
    expect(empty.actions).toEqual([]);

    const state = await stateStore.load();
    expect(state).toBeTruthy();
    if (!state) {
      return;
    }

    // Seed a local receiver pending action without going through A2A.
    const actionId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c100";
    const seeded = {
      ...state,
      actionExecutions: [
        ...(state.actionExecutions ?? []),
        {
          actionId,
          requesterParticipantId: state.localParticipant.participant.id,
          targetParticipantId: state.localParticipant.participant.id,
          actionType: "repository.edit",
          capabilityId: "repository.edit",
          status: "approval_required",
          parameters: {},
          parameterDigest: "a".repeat(64),
          mutability: "mutation",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          executorInvocationCount: 0,
          approvalBinding: {
            requesterParticipantId: state.localParticipant.participant.id,
            targetParticipantId: state.localParticipant.participant.id,
            actionId,
            capabilityId: "repository.edit",
            actionType: "repository.edit",
            parameterDigest: "a".repeat(64),
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }
        }
      ]
    };
    await stateStore.save(seeded as typeof state);

    const pending = await client.listPendingActions();
    expect(pending.actions).toHaveLength(1);
    expect((pending.actions[0] as { actionId: string }).actionId).toBe(actionId);

    const got = await client.getAction(actionId);
    expect((got as { status: string }).status).toBe("approval_required");
    expect((got as { actionLabel: string }).actionLabel).toBe("Apply change");

    const listed = await client.listActions("pending");
    expect(listed.actions.length).toBeGreaterThanOrEqual(1);

    const web = await fetch(`${server.baseUrl}/control/web/`);
    expect(web.status).toBe(200);
    expect(web.headers.get("content-type")).toContain("text/html");
    const html = await web.text();
    expect(html).toContain("Aroko");
    expect(html).toContain('data-view="home"');
    expect(html).toContain('data-view="people"');
    expect(html).toContain('data-view="live"');
    expect(html).toContain('data-view="needs-you"');
    expect(html).toContain('data-view="history"');
    expect(html).toContain('data-view="settings"');
    expect(html).toContain("notify-banner");
    expect(html).toContain("Enable Notifications");
    expect(html).not.toMatch(/Receiver Control/i);
    expect(html).not.toContain("PairMesh Inbox");
  });

  it("serves Aroko shell assets without purple PairMesh branding mark class content", async () => {
    const { server } = await startPlane();
    const css = await fetch(`${server.baseUrl}/control/web/app.css`);
    expect(css.status).toBe(200);
    const cssText = await css.text();
    expect(cssText).toContain("--color-accent");
    expect(cssText).toContain("prefers-reduced-motion");
    expect(cssText).not.toMatch(/#6c5ce7/);

    const js = await fetch(`${server.baseUrl}/control/web/app.js`);
    expect(js.status).toBe(200);
    const script = await js.text();
    expect(script).toContain("normalizeControlCenterView");
    expect(script).toContain("buildHomeModel");
    expect(script).toContain("buildPersonDetailModel");
    expect(script).toContain("Connect someone");
    expect(script).toContain("Approve once");
    expect(script).toContain("repository.edit");
    expect(script).toContain("mergeLiveWorkItems");
    expect(script).toContain("mergeNeedsYouItems");
    expect(script).toContain("permissions/");
    expect(script).toMatch(/isAllowSessionForbidden/);
    expect(script).toMatch(/actionType !== "repository\.edit"/);
    expect(script).toContain("buildSettingsModel");
    expect(script).toContain("renderSettings");
    expect(script).toContain("/leave");
    expect(script).toContain("home-onboarding");
    expect(script).toContain("data-settings-copy-diagnostics");

    const peopleHelpers = await fetch(`${server.baseUrl}/control/web/people-present.js`);
    expect(peopleHelpers.status).toBe(200);
    const helpers = await peopleHelpers.text();
    expect(helpers).toContain("Apply approved code changes");
    expect(helpers).not.toMatch(/Always allow/);

    const liveHelpers = await fetch(`${server.baseUrl}/control/web/live-present.js`);
    expect(liveHelpers.status).toBe(200);
    const live = await liveHelpers.text();
    expect(live).toContain("Nothing is running right now");
    expect(live).toContain("Approve once");
    expect(live).toMatch(/MODIFY\s*\/\s*CREATE\s*\/\s*DELETE\s*\/\s*RENAME/i);
    expect(live).not.toMatch(/Allow for session/);

    const historyHelpers = await fetch(`${server.baseUrl}/control/web/history-present.js`);
    expect(historyHelpers.status).toBe(200);
    const history = await historyHelpers.text();
    expect(history).toContain("mergeHistoryItems");
    expect(history).toContain("Agent information unavailable");
    expect(history).toContain("stored locally");

    const settingsHelpers = await fetch(`${server.baseUrl}/control/web/settings-present.js`);
    expect(settingsHelpers.status).toBe(200);
    const settings = await settingsHelpers.text();
    expect(settings).toContain("buildSettingsModel");
    expect(settings).toContain("Automatic update checking isn't available yet");
    expect(settings).not.toMatch(/inviteSecret\s*[:=]/);
    expect(settings).not.toMatch(/Bearer\s+\$\{/);
  });
  it("exposes notification status / enable / dismiss without treating browser open as delivery", async () => {
    const { client, server, token } = await startPlane();
    const isolatedHome = await mkdtemp(join(tmpdir(), "pairmesh-notify-home-"));
    const previousHome = process.env.PAIRMESH_HOME;
    process.env.PAIRMESH_HOME = isolatedHome;
    try {
      const status = await client.getNotificationStatus();
      expect(status).toMatchObject({
        platform: expect.any(String),
        adapter: expect.any(String),
        authorization: expect.any(String),
        shouldPrompt: expect.any(Boolean),
        canRequestPermission: expect.any(Boolean),
        canOpenSettings: expect.any(Boolean),
        headline: expect.any(String),
        body: expect.any(String),
        primaryAction: expect.any(String)
      });
      expect(JSON.stringify(status)).not.toMatch(/openedBrowser|browserOpened/i);

      const dismissed = await client.dismissNotificationPrompt();
      expect(dismissed.shouldPrompt).toBe(false);

      const js = await fetch(`${server.baseUrl}/control/web/app.js`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(js.status).toBe(200);
      const script = await js.text();
      expect(script).toContain("notifications/status");
      expect(script).toContain("notifications/enable");
      expect(script).toContain("notifications/open-settings");
      expect(script).not.toMatch(/delivered.*open.*browser|browser.*delivered/i);
    } finally {
      if (previousHome === undefined) {
        delete process.env.PAIRMESH_HOME;
      } else {
        process.env.PAIRMESH_HOME = previousHome;
      }
    }
  });
});

describe("Invite initial grant helpers", () => {
  it("fills missing capabilities from registry defaults", () => {
    const resolved = resolveInviteInitialGrants([
      { capabilityId: "repository.inspect", policy: "deny" }
    ]);
    expect(resolved.find((g) => g.capabilityId === "repository.inspect")?.policy).toBe("deny");
    expect(resolved.find((g) => g.capabilityId === "repository.source_references")?.policy).toBe(
      "allow_session"
    );
  });
});

describe("runtime.json control fields", () => {
  it("persists controlUrl and controlToken with schema validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pairmesh-runtime-control-"));
    await writeRuntimeInfo(root, {
      pid: process.pid,
      port: 47102,
      baseUrl: "http://127.0.0.1:47102",
      agentName: "agent",
      startedAt: new Date().toISOString(),
      controlUrl: "http://127.0.0.1:47200",
      controlToken: "test-token-value"
    });
    const raw = await readFile(join(root, ".pairmesh", "runtime.json"), "utf8");
    const parsed = JSON.parse(raw) as { controlUrl: string; controlToken: string };
    expect(parsed.controlUrl).toBe("http://127.0.0.1:47200");
    expect(parsed.controlToken).toBe("test-token-value");
  });
});
