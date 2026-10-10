import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deliverOwnerNotification, resolveBundledMacNotifierPath } from "./deliver.js";
import {
  loadNotificationOnboardingPrefs,
  markNotificationDelivered,
  markNotificationPromptDismissed,
  saveNotificationOnboardingPrefs,
  type NotificationOnboardingPrefs
} from "./onboarding-prefs.js";

const execFileAsync = promisify(execFile);

/**
 * Platform-neutral authorization classification.
 * PairMesh never bypasses OS consent — this only observes / initiates native flows.
 */
export type NotificationAuthorization =
  "not_determined" | "authorized" | "denied" | "unavailable" | "unsupported";

/** Documented future / current delivery adapters (implementation may be stubbed). */
export type NotificationAdapterId =
  "bundled-mac-notifier" | "notify-send" | "windows-toast" | "none";

export interface NotificationPermissionSnapshot {
  platform: NodeJS.Platform;
  adapter: NotificationAdapterId;
  authorization: NotificationAuthorization;
  /** Show in-product Enable / Settings coaching. */
  shouldPrompt: boolean;
  canRequestPermission: boolean;
  canOpenSettings: boolean;
  /** Privacy-safe copy for Control Inbox / CLI. */
  headline: string;
  body: string;
  primaryAction: "enable" | "open_settings" | "none";
}

export interface NotificationPermissionOptions {
  prefsPath?: string;
  /** Injected for tests. */
  deliver?: typeof deliverOwnerNotification;
  openSettingsFn?: () => Promise<boolean>;
  platform?: NodeJS.Platform;
  resolveBundledMacNotifierPath?: () => string | undefined;
  now?: () => Date;
}

/**
 * Observe notification permission / readiness without bypassing OS consent.
 */
export async function getNotificationPermissionSnapshot(
  options: NotificationPermissionOptions = {}
): Promise<NotificationPermissionSnapshot> {
  const platform = options.platform ?? process.platform;
  const prefs = await loadNotificationOnboardingPrefs(options.prefsPath);

  if (platform === "darwin") {
    return snapshotDarwin(prefs, options);
  }
  if (platform === "linux") {
    return snapshotLinux(prefs);
  }
  if (platform === "win32") {
    return snapshotWindows(prefs);
  }
  return {
    platform,
    adapter: "none",
    authorization: "unsupported",
    shouldPrompt: false,
    canRequestPermission: false,
    canOpenSettings: false,
    headline: "Notifications unavailable",
    body: "This platform does not support PairMesh OS notifications yet.",
    primaryAction: "none"
  };
}

/**
 * Initiate the native permission flow where the OS allows it.
 * On macOS this posts a consent-friendly probe via the bundled notifier
 * (first delivery triggers the system prompt). Never fabricates consent.
 */
export async function requestNotificationPermission(
  options: NotificationPermissionOptions = {}
): Promise<NotificationPermissionSnapshot> {
  const platform = options.platform ?? process.platform;
  const deliver = options.deliver ?? deliverOwnerNotification;

  if (platform === "darwin") {
    const bundled = options.resolveBundledMacNotifierPath?.() ?? resolveBundledMacNotifierPath();
    if (!bundled) {
      return getNotificationPermissionSnapshot(options);
    }
    const result = await deliver(
      {
        title: "PairMesh notifications",
        body: "Enable notifications so you know when a collaborator needs your approval.",
        kind: "approval_required",
        actionId: "act_notify_onboarding_probe",
        openUrl: undefined
      },
      { resolveBundledMacNotifierPath: () => bundled }
    );
    const prefs = await loadNotificationOnboardingPrefs(options.prefsPath);
    if (result.delivered) {
      await markNotificationDelivered(options.prefsPath);
    } else if (result.permissionDenied) {
      prefs.lastAuthorization = "denied";
      await saveNotificationOnboardingPrefs(prefs, options.prefsPath);
    } else {
      prefs.lastAuthorization = "unavailable";
      await saveNotificationOnboardingPrefs(prefs, options.prefsPath);
    }
    return getNotificationPermissionSnapshot(options);
  }

    return getNotificationPermissionSnapshot(options);
}

/**
 * Open the OS notification settings surface when available.
 */
export async function openNotificationSettings(
  options: NotificationPermissionOptions = {}
): Promise<{ opened: boolean }> {
  if (options.openSettingsFn) {
    return { opened: await options.openSettingsFn() };
  }
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    try {
      // macOS Ventura+ Notifications settings pane. Deep-linking a single app
      // is unreliable across OS versions — open the pane and name PairMesh in UI copy.
      await execFileAsync("open", [
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
      ]);
      return { opened: true };
    } catch {
      try {
        await execFileAsync("open", ["/System/Library/PreferencePanes/Notifications.prefPane"]);
        return { opened: true };
      } catch {
        return { opened: false };
      }
    }
  }
  if (platform === "linux") {
    // Best-effort; distributions vary. Never claim success without a launch.
    for (const candidate of [
      ["gnome-control-center", ["notifications"]],
      ["xdg-open", ["settings://notification"]]
    ] as const) {
      try {
        await execFileAsync(candidate[0], [...candidate[1]]);
        return { opened: true };
      } catch {
        /* try next */
      }
    }
    return { opened: false };
  }
  // Windows toast settings adapter is future work.
  return { opened: false };
}

export async function dismissNotificationOnboardingPrompt(
  options: NotificationPermissionOptions = {}
): Promise<NotificationPermissionSnapshot> {
  await markNotificationPromptDismissed(options.prefsPath);
  return getNotificationPermissionSnapshot(options);
}

function snapshotDarwin(
  prefs: NotificationOnboardingPrefs,
  options: NotificationPermissionOptions
): NotificationPermissionSnapshot {
  const bundled = options.resolveBundledMacNotifierPath?.() ?? resolveBundledMacNotifierPath();
  if (!bundled) {
    return {
      platform: "darwin",
      adapter: "none",
      authorization: "unavailable",
      shouldPrompt: false,
      canRequestPermission: false,
      canOpenSettings: true,
      headline: "Notifications unavailable",
      body: "The PairMesh macOS notifier is missing from this install.",
      primaryAction: "open_settings"
    };
  }

  let authorization: NotificationAuthorization = "not_determined";
  if (prefs.lastDeliveredAt || prefs.lastAuthorization === "authorized") {
    authorization = "authorized";
  } else if (prefs.lastAuthorization === "denied") {
    authorization = "denied";
  } else if (prefs.lastAuthorization === "unavailable") {
    authorization = "unavailable";
  }

  const declined = prefs.dismissed || Boolean(prefs.declinedAt);
  if (authorization === "authorized") {
    return {
      platform: "darwin",
      adapter: "bundled-mac-notifier",
      authorization,
      shouldPrompt: false,
      canRequestPermission: false,
      canOpenSettings: true,
      headline: "Notifications on",
      body: "PairMesh can alert you when a collaborator needs your approval.",
      primaryAction: "none"
    };
  }

  if (authorization === "denied") {
    return {
      platform: "darwin",
      adapter: "bundled-mac-notifier",
      authorization,
      shouldPrompt: !declined,
      canRequestPermission: false,
      canOpenSettings: true,
      headline: "Notifications blocked",
      body: "PairMesh cannot show approval alerts until you allow notifications for PairMesh in System Settings.",
      primaryAction: "open_settings"
    };
  }

  return {
    platform: "darwin",
    adapter: "bundled-mac-notifier",
    authorization: "not_determined",
    shouldPrompt: !declined,
    canRequestPermission: true,
    canOpenSettings: true,
    headline: "Enable notifications",
    body: "Enable notifications so you know when a collaborator needs your approval.",
    primaryAction: "enable"
  };
}

function snapshotLinux(prefs: NotificationOnboardingPrefs): NotificationPermissionSnapshot {
  // Delivery adapter exists (notify-send); permission UX is deferred.
  const declined = prefs.dismissed || Boolean(prefs.declinedAt);
  return {
    platform: "linux",
    adapter: "notify-send",
    authorization: prefs.lastDeliveredAt ? "authorized" : "not_determined",
    shouldPrompt: false,
    canRequestPermission: false,
    canOpenSettings: true,
    headline: "Desktop notifications",
    body: "Linux notification onboarding ships with a later desktop adapter pass.",
    primaryAction: declined ? "none" : "none"
  };
}

function snapshotWindows(prefs: NotificationOnboardingPrefs): NotificationPermissionSnapshot {
  void prefs;
  return {
    platform: "win32",
    adapter: "windows-toast",
    authorization: "unsupported",
    shouldPrompt: false,
    canRequestPermission: false,
    canOpenSettings: false,
    headline: "Windows notifications coming later",
    body: "Windows Toast adapter is planned; macOS bundled notifier is the Stage 16 path.",
    primaryAction: "none"
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
