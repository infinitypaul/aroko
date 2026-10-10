import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { deliverOwnerNotification, resolveBundledMacNotifierPath } from "./deliver.js";
import { OwnerPresence } from "./owner-presence.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import type { ActionExecutionRecord } from "@pairmesh/protocol";
import { PeerIdSchema, SessionIdSchema } from "@pairmesh/protocol";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn()
  };
});

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

const mockedExecFile = vi.mocked(execFile);

describe("Stage 16 — notification delivery (macOS bundled notifier)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockedExecFile.mockReset();
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("prefers bundled mac notifier and attaches -open for deep-link", async () => {
    mockedExecFile.mockImplementation((_file, _args, callback) => {
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await deliverOwnerNotification(
      {
        title: "PairMesh — review needed",
        body: "Paul requested a change apply.",
        kind: "approval_required",
        actionId: "act_test",
        openUrl: "http://127.0.0.1:9999/control/web/#token=tok&action=act_test"
      },
      { resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier" }
    );

    expect(result).toEqual({
      delivered: true,
      method: "bundled-mac-notifier",
      clickOpensUrl: true
    });
    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [bin, args] = mockedExecFile.mock.calls[0]!;
    expect(bin).toBe("/fake/bundled/terminal-notifier");
    expect(args).toEqual(
      expect.arrayContaining([
        "-title",
        "PairMesh — review needed",
        "-message",
        "Paul requested a change apply.",
        "-group",
        "pairmesh",
        "-open",
        "http://127.0.0.1:9999/control/web/#token=tok&action=act_test"
      ])
    );
  });

  it("execs .app binary directly; falls back to open -n (no -W) when direct exec fails", async () => {
    const appBinary =
      "/opt/homebrew/lib/node_modules/@pairmesh/cli/node_modules/@pairmesh/client/vendor/macos/terminal-notifier.app/Contents/MacOS/terminal-notifier";
    let call = 0;
    mockedExecFile.mockImplementation((file, _args, _optsOrCb, callback) => {
      const cb = typeof _optsOrCb === "function" ? _optsOrCb : callback;
      call += 1;
      if (typeof cb === "function") {
        if (call === 1 && file === appBinary) {
          cb(new Error("spawn EPERM"), "", "");
        } else {
          cb(null, "", "");
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await deliverOwnerNotification(
      {
        title: "PairMesh — review needed",
        body: "Background delivery probe.",
        kind: "approval_required",
        actionId: "act_bg",
        openUrl: "http://127.0.0.1/inbox"
      },
      { resolveBundledMacNotifierPath: () => appBinary }
    );

    expect(result.delivered).toBe(true);
    expect(result.method).toBe("bundled-mac-notifier");
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
    expect(mockedExecFile.mock.calls[0]![0]).toBe(appBinary);
    const [cmd, args] = mockedExecFile.mock.calls[1]!;
    expect(cmd).toBe("open");
    expect(args).toEqual(
      expect.arrayContaining([
        "-n",
        "/opt/homebrew/lib/node_modules/@pairmesh/cli/node_modules/@pairmesh/client/vendor/macos/terminal-notifier.app",
        "--args",
        "-title",
        "PairMesh — review needed",
        "-open",
        "http://127.0.0.1/inbox"
      ])
    );
    expect(args).not.toEqual(expect.arrayContaining(["-W"]));
  });

  it("does not open a browser as part of deliverOwnerNotification", async () => {
    mockedExecFile.mockImplementation((_file, _args, callback) => {
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await deliverOwnerNotification(
      {
        title: "t",
        body: "b",
        kind: "approval_required",
        actionId: "act_x",
        openUrl: "http://127.0.0.1/inbox"
      },
      { resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier" }
    );

    expect(result.delivered).toBe(true);
    expect(result).not.toHaveProperty("openedBrowser");
    // Only the notifier binary was invoked — never `open` / browser helpers.
    expect(mockedExecFile.mock.calls.every((call) => call[0] !== "open")).toBe(true);
  });

  it("falls back to osascript without claiming clickOpensUrl", async () => {
    mockedExecFile.mockImplementation((file, _args, callback) => {
      if (typeof callback === "function") {
        if (file === "osascript") {
          callback(null, "", "");
        } else {
          callback(new Error("missing"), "", "");
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await deliverOwnerNotification(
      {
        title: "t",
        body: "b",
        kind: "approval_required",
        actionId: "act_x",
        openUrl: "http://127.0.0.1/inbox"
      },
      {
        resolveBundledMacNotifierPath: () => undefined,
        systemMacNotifierPaths: []
      }
    );

    expect(result.method).toBe("osascript");
    expect(result.delivered).toBe(true);
    expect(result.clickOpensUrl).toBe(false);
  });

  it("does not paper over a failed shipped notifier with osascript", async () => {
    mockedExecFile.mockImplementation((file, _args, callback) => {
      if (typeof callback === "function") {
        if (file === "osascript") {
          callback(null, "", "");
        } else {
          callback(Object.assign(new Error("denied"), { code: 3 }), "", "");
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await deliverOwnerNotification(
      {
        title: "t",
        body: "b",
        kind: "approval_required",
        actionId: "act_x",
        openUrl: "http://127.0.0.1/inbox"
      },
      { resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier" }
    );

    expect(result.delivered).toBe(false);
    expect(result.method).toBe("none");
    expect(result.permissionDenied).toBe(true);
    expect(mockedExecFile.mock.calls.some((call) => call[0] === "osascript")).toBe(false);
  });

  it("OwnerPresence default does not auto-open Inbox; failed notify does not open browser", async () => {
    const openBrowser = vi.fn(async () => true);
    const presence = new OwnerPresence({
      controlBaseUrl: "http://127.0.0.1:9999",
      controlToken: "tok_test",
      deliver: async () => ({ delivered: false, method: "none", clickOpensUrl: false }),
      openBrowser
      // openBrowserOnApproval omitted → default false
    });

    const kind = await presence.handleActionTransition({
      state: baseState(),
      next: approvalAction()
    });
    expect(kind).toBe("approval_required");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("OwnerPresence openBrowserOnApproval only runs after successful delivery", async () => {
    const openBrowser = vi.fn(async () => true);
    const failing = new OwnerPresence({
      controlBaseUrl: "http://127.0.0.1:9999",
      controlToken: "tok_test",
      deliver: async () => ({ delivered: false, method: "none", clickOpensUrl: false }),
      openBrowser,
      openBrowserOnApproval: true
    });
    await failing.handleActionTransition({ state: baseState(), next: approvalAction() });
    expect(openBrowser).not.toHaveBeenCalled();

    const succeeding = new OwnerPresence({
      controlBaseUrl: "http://127.0.0.1:9999",
      controlToken: "tok_test",
      deliver: async () => ({
        delivered: true,
        method: "bundled-mac-notifier",
        clickOpensUrl: true
      }),
      openBrowser,
      openBrowserOnApproval: true
    });
    await succeeding.handleActionTransition({ state: baseState(), next: approvalAction() });
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(openBrowser.mock.calls[0]![0]).toContain("token=tok_test");
  });

  it("OwnerPresence does not burn dedupe key when delivery fails (retryable)", async () => {
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ delivered: false, method: "none", clickOpensUrl: false })
      .mockResolvedValueOnce({
        delivered: true,
        method: "bundled-mac-notifier",
        clickOpensUrl: true
      });
    const presence = new OwnerPresence({
      controlBaseUrl: "http://127.0.0.1:9999",
      controlToken: "tok_test",
      deliver
    });
    const next = approvalAction();
    await presence.handleActionTransition({ state: baseState(), next });
    await presence.handleActionTransition({ state: baseState(), next });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("resolveBundledMacNotifierPath finds shipped vendor/macos binary when present", () => {
    const path = resolveBundledMacNotifierPath();
    // PairMesh ships terminal-notifier.app under packages/client/vendor/macos.
    if (process.platform === "darwin") {
      expect(path).toMatch(/terminal-notifier$/);
    }
  });
});

function approvalAction(): ActionExecutionRecord {
  return {
    actionId: "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4af99",
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    actionType: "repository.edit",
    capabilityId: "repository.edit",
    status: "approval_required",
    parameters: { instruction: "fix retry" },
    parameterDigest: "a".repeat(64),
    mutability: "mutation",
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    executorInvocationCount: 0
  } as ActionExecutionRecord;
}

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-NOTIFY1",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
      createdAt: "2026-08-25T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: { id: kelvinId } as LocalSessionState["localParticipant"]["participant"],
      agent: {
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      } as LocalSessionState["localParticipant"]["agent"],
      developer: {
        id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        displayName: "Kelvin"
      } as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: [
      {
        participant: { id: paulId } as LocalSessionState["peers"][number]["participant"],
        agent: {} as LocalSessionState["peers"][number]["agent"],
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          displayName: "Paul"
        } as LocalSessionState["peers"][number]["developer"],
        a2aAgentUrl: "http://127.0.0.1:9/",
        isLocal: false,
        serviceLabel: "payment-service"
      }
    ]
  };
}
