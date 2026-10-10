import { execFile } from "node:child_process";

export type ControlInboxView =
  "inbox" | "activity" | "history" | "home" | "people" | "live" | "needs-you" | "settings";

export interface ControlDeepLinkTarget {
  /** Specific action to open (review / proposal). */
  actionId?: string;
  /** Tab/view to select when no action, or initial tab before select. */
  view?: ControlInboxView;
}

const KNOWN_VIEWS = new Set<ControlInboxView>([
  "inbox",
  "activity",
  "history",
  "home",
  "people",
  "live",
  "needs-you",
  "settings"
]);

/**
 * Build Inbox URL with a one-time exchange code (not the long-lived Bearer).
 */
export function buildControlInboxUrl(
  controlBaseUrl: string,
  exchangeCode: string,
  target: ControlDeepLinkTarget = {}
): string {
  const base = controlBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("code", exchangeCode);
  if (target.actionId?.trim()) {
    params.set("action", target.actionId.trim());
  }
  if (target.view) {
    params.set("view", target.view);
  } else if (target.actionId?.trim()) {
    params.set("view", "inbox");
  }
  // Trailing slash matters: relative assets on /control/web resolve to /control/*,
  // so deep-links must land on /control/web/ (see control-web/index.html absolute paths too).
  return `${base}/control/web/#${params.toString()}`;
}

/** Safe URL for operator print when browser open fails — no secrets. */
export function buildControlInboxPublicUrl(controlBaseUrl: string): string {
  return `${controlBaseUrl.replace(/\/$/, "")}/control/web`;
}

export function parseControlDeepLinkHash(hash: string): {
  code?: string;
  /** @deprecated Legacy deep-links; prefer exchange code. */
  token?: string;
  actionId?: string;
  view?: ControlInboxView;
} {
  const raw = hash.replace(/^#/, "");
  if (!raw) {
    return {};
  }
  const params = new URLSearchParams(raw);
  const code = params.get("code") ?? undefined;
  const token = params.get("token") ?? undefined;
  const actionId = params.get("action") ?? undefined;
  const viewRaw = params.get("view");
  const view =
    viewRaw && KNOWN_VIEWS.has(viewRaw as ControlInboxView)
      ? (viewRaw as ControlInboxView)
      : undefined;
  return {
    ...(code ? { code } : {}),
    ...(token ? { token } : {}),
    ...(actionId ? { actionId } : {}),
    ...(view ? { view } : {})
  };
}

export async function openControlInboxInBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await execFile("open", [url]);
      return true;
    }
    if (platform === "win32") {
      await execFile("cmd", ["/c", "start", "", url]);
      return true;
    }
    await execFile("xdg-open", [url]);
    return true;
  } catch {
    return false;
  }
}
