import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dismissNotificationOnboardingPrompt,
  getNotificationPermissionSnapshot,
  openNotificationSettings,
  requestNotificationPermission
} from "./permission.js";
import {
  loadNotificationOnboardingPrefs,
  markNotificationDelivered,
  markNotificationPromptDismissed,
  saveNotificationOnboardingPrefs
} from "./onboarding-prefs.js";
import type { NotificationDeliveryResult } from "./deliver.js";

describe("notification onboarding prefs", () => {
  it("persists dismissed / delivered without nagging after decline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-prefs-"));
    const path = join(dir, "notification-onboarding.json");

    await markNotificationPromptDismissed(path);
    const declined = await loadNotificationOnboardingPrefs(path);
    expect(declined.dismissed).toBe(true);
    expect(declined.declinedAt).toBeTruthy();

    await markNotificationDelivered(path);
    const delivered = await loadNotificationOnboardingPrefs(path);
    expect(delivered.lastAuthorization).toBe("authorized");
    expect(delivered.lastDeliveredAt).toBeTruthy();

    const raw = JSON.parse(await readFile(path, "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });
});

describe("notification permission snapshot (platform-neutral)", () => {
  it("macOS first-use prompts Enable when not determined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-perm-"));
    const prefsPath = join(dir, "prefs.json");
    const snap = await getNotificationPermissionSnapshot({
      platform: "darwin",
      prefsPath,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(snap.adapter).toBe("bundled-mac-notifier");
    expect(snap.authorization).toBe("not_determined");
    expect(snap.shouldPrompt).toBe(true);
    expect(snap.canRequestPermission).toBe(true);
    expect(snap.primaryAction).toBe("enable");
    expect(snap.body).toMatch(/collaborator needs your approval/i);
  });

  it("does not nag after intentional dismiss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-nag-"));
    const prefsPath = join(dir, "prefs.json");
    await markNotificationPromptDismissed(prefsPath);
    const snap = await getNotificationPermissionSnapshot({
      platform: "darwin",
      prefsPath,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(snap.shouldPrompt).toBe(false);
  });

  it("denied state surfaces Open Settings and respects dismiss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-denied-"));
    const prefsPath = join(dir, "prefs.json");
    await saveNotificationOnboardingPrefs(
      { dismissed: false, lastAuthorization: "denied" },
      prefsPath
    );
    const snap = await getNotificationPermissionSnapshot({
      platform: "darwin",
      prefsPath,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(snap.authorization).toBe("denied");
    expect(snap.shouldPrompt).toBe(true);
    expect(snap.primaryAction).toBe("open_settings");
    expect(snap.canRequestPermission).toBe(false);

    const after = await dismissNotificationOnboardingPrompt({
      platform: "darwin",
      prefsPath,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(after.shouldPrompt).toBe(false);
  });

  it("authorized after successful delivery stops coaching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-ok-"));
    const prefsPath = join(dir, "prefs.json");
    await markNotificationDelivered(prefsPath);
    const snap = await getNotificationPermissionSnapshot({
      platform: "darwin",
      prefsPath,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(snap.authorization).toBe("authorized");
    expect(snap.shouldPrompt).toBe(false);
    expect(snap.primaryAction).toBe("none");
  });

  it("documents Windows Toast adapter without implementing delivery", async () => {
    const snap = await getNotificationPermissionSnapshot({ platform: "win32" });
    expect(snap.adapter).toBe("windows-toast");
    expect(snap.authorization).toBe("unsupported");
    expect(snap.shouldPrompt).toBe(false);
    expect(snap.canRequestPermission).toBe(false);
  });

  it("documents Linux notify-send adapter without Stage 16 onboarding UI", async () => {
    const snap = await getNotificationPermissionSnapshot({ platform: "linux" });
    expect(snap.adapter).toBe("notify-send");
    expect(snap.shouldPrompt).toBe(false);
  });

  it("Enable initiates native probe and records delivered success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-enable-"));
    const prefsPath = join(dir, "prefs.json");
    const deliver = async (): Promise<NotificationDeliveryResult> => ({
      delivered: true,
      method: "bundled-mac-notifier",
      clickOpensUrl: false
    });
    const snap = await requestNotificationPermission({
      platform: "darwin",
      prefsPath,
      deliver,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(snap.authorization).toBe("authorized");
    expect(snap.shouldPrompt).toBe(false);
  });

  it("Enable records permissionDenied without fabricating consent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-notify-deny-probe-"));
    const prefsPath = join(dir, "prefs.json");
    const deliver = async (): Promise<NotificationDeliveryResult> => ({
      delivered: false,
      method: "none",
      clickOpensUrl: false,
      permissionDenied: true
    });
    const snap = await requestNotificationPermission({
      platform: "darwin",
      prefsPath,
      deliver,
      resolveBundledMacNotifierPath: () => "/fake/bundled/terminal-notifier"
    });
    expect(snap.authorization).toBe("denied");
    expect(snap.primaryAction).toBe("open_settings");
    expect(snap.canRequestPermission).toBe(false);
  });

  it("openNotificationSettings uses injectable opener", async () => {
    let called = false;
    const result = await openNotificationSettings({
      platform: "darwin",
      openSettingsFn: async () => {
        called = true;
        return true;
      }
    });
    expect(called).toBe(true);
    expect(result.opened).toBe(true);
  });
});
