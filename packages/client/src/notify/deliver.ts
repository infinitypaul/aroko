import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OwnerNotificationPayload } from "./attention.js";

const execFileAsync = promisify(execFile);

/**
 * Platform-neutral delivery result.
 * Browser opening is intentionally NOT part of this API — callers must not
 * treat Inbox auto-open as notification success.
 */
export type NotificationDeliveryMethod =
  "bundled-mac-notifier" | "system-mac-notifier" | "osascript" | "notify-send" | "none";

export interface NotificationDeliveryResult {
  delivered: boolean;
  method: NotificationDeliveryMethod;
  /** True when clicking the notification opens `payload.openUrl`. */
  clickOpensUrl: boolean;
  /**
   * True when the OS / notifier reported notification authorization denied
   * (e.g. terminal-notifier exit 3). Never invent consent — callers may coach
   * the user toward System Settings.
   */
  permissionDenied?: boolean;
}

export interface DeliverOwnerNotificationOptions {
  /**
   * Optional override for resolving the shipped macOS notifier binary
   * (tests / custom embeds).
   */
  resolveBundledMacNotifierPath?: () => string | undefined;
  /** Test override — skip optional Homebrew/system installs. */
  systemMacNotifierPaths?: readonly string[];
}

/**
 * Deliver a privacy-safe OS notification.
 *
 * macOS: prefer PairMesh-shipped universal terminal-notifier (vendor/macos).
 * Optional system install is diagnostic-only. osascript is last resort only
 * when no shipped binary is present — never used to paper over a failed
 * shipped/system notifier attempt (permission denied must stay honest).
 * Linux: notify-send. Windows: not implemented yet (returns none).
 *
 * Does not open a browser. Deep-links belong on the notification click
 * (`-open`) or a separate explicit caller action.
 */
export async function deliverOwnerNotification(
  payload: OwnerNotificationPayload,
  options: DeliverOwnerNotificationOptions = {}
): Promise<NotificationDeliveryResult> {
  if (process.platform === "darwin") {
    const bundled =
      options.resolveBundledMacNotifierPath !== undefined
        ? options.resolveBundledMacNotifierPath()
        : resolveBundledMacNotifierPath();
    if (bundled) {
      // Shipped binary present: its result is authoritative (incl. NC denial).
            return runMacNotifierBinary(bundled, payload, "bundled-mac-notifier");
    }
    const systemPaths = options.systemMacNotifierPaths ?? SYSTEM_MAC_NOTIFIER_PATHS;
    for (const systemPath of systemPaths) {
      if (await pathExists(systemPath)) {
        return runMacNotifierBinary(systemPath, payload, "system-mac-notifier");
      }
    }
    return tryOsascript(payload);
  }

  if (process.platform === "linux") {
    return tryNotifySend(payload);
  }

  return { delivered: false, method: "none", clickOpensUrl: false };
}

const SYSTEM_MAC_NOTIFIER_PATHS = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier"
] as const;

/**
 * Resolve the macOS notifier binary shipped with PairMesh
 * (`packages/client/vendor/macos/terminal-notifier.app`). No Homebrew required.
 */
export function resolveBundledMacNotifierPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Runtime: packages/client/dist/notify → ../../vendor/macos/...
    join(
      here,
      "..",
      "..",
      "vendor",
      "macos",
      "terminal-notifier.app",
      "Contents",
      "MacOS",
      "terminal-notifier"
    ),
    // Dev / unusual layouts: packages/client/src/notify → same relative vendor
    join(
      here,
      "..",
      "..",
      "..",
      "vendor",
      "macos",
      "terminal-notifier.app",
      "Contents",
      "MacOS",
      "terminal-notifier"
    )
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * `…/PairMesh.app/Contents/MacOS/pairmesh` → `…/PairMesh.app`
 * Used so background PairMesh workers can post via LaunchServices.
 */
export function resolveMacAppBundlePath(binary: string): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const index = binary.lastIndexOf(marker);
  if (index === -1) {
    return undefined;
  }
  return binary.slice(0, index + ".app".length);
}

async function runMacNotifierBinary(
  binary: string,
  payload: OwnerNotificationPayload,
  method: "bundled-mac-notifier" | "system-mac-notifier"
): Promise<NotificationDeliveryResult> {
  const args = ["-title", payload.title, "-message", payload.body, "-group", "pairmesh"];
  if (payload.openUrl) {
    args.push("-open", payload.openUrl);
  }

  // Direct exec first (matches Terminal probe). For .app bundles, if that
  // fails from a detached `pairmesh start` worker, fall back to LaunchServices
  // `open -n` without `-W` — `-W` waits for app exit and times out when
  // `-open` keeps the notifier alive until the banner is clicked.
  try {
    await execFileAsync(binary, args);
    return {
      delivered: true,
      method,
      clickOpensUrl: Boolean(payload.openUrl)
    };
  } catch (error) {
    if (isNotifierPermissionDenied(error)) {
      return {
        delivered: false,
        method: "none",
        clickOpensUrl: false,
        permissionDenied: true
      };
    }
    const appBundle = resolveMacAppBundlePath(binary);
    if (!appBundle) {
      // Non-zero exits include notification permission denied (3.x exit 3).
      return { delivered: false, method: "none", clickOpensUrl: false };
    }
    try {
      await execFileAsync("open", ["-n", appBundle, "--args", ...args], {
        timeout: 8_000
      });
      return {
        delivered: true,
        method,
        clickOpensUrl: Boolean(payload.openUrl)
      };
    } catch (openError) {
      if (isNotifierPermissionDenied(openError)) {
        return {
          delivered: false,
          method: "none",
          clickOpensUrl: false,
          permissionDenied: true
        };
      }
      return { delivered: false, method: "none", clickOpensUrl: false };
    }
  }
}

function isNotifierPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: number | string; status?: number }).code;
  const status = (error as { status?: number }).status;
  return code === 3 || code === "3" || status === 3;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function tryOsascript(
  payload: OwnerNotificationPayload
): Promise<NotificationDeliveryResult> {
  const title = escapeAppleScript(payload.title);
  const body = escapeAppleScript(payload.body);
  try {
    await execFileAsync("osascript", [
      "-e",
      `display notification "${body}" with title "${title}" sound name "default"`
    ]);
    // osascript cannot attach a click URL; do not claim clickOpensUrl.
    // Background PairMesh may still get a suppressed banner — callers must
    // not treat this as equivalent to bundled-mac-notifier success for freeze.
    return { delivered: true, method: "osascript", clickOpensUrl: false };
  } catch {
    return { delivered: false, method: "none", clickOpensUrl: false };
  }
}

async function tryNotifySend(
  payload: OwnerNotificationPayload
): Promise<NotificationDeliveryResult> {
  try {
    await execFileAsync("notify-send", [payload.title, payload.body]);
    return {
      delivered: true,
      method: "notify-send",
      clickOpensUrl: false
    };
  } catch {
    return { delivered: false, method: "none", clickOpensUrl: false };
  }
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
