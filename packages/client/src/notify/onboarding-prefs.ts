import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getPairMeshHome } from "../local-config/paths.js";

export interface NotificationOnboardingPrefs {
  /** User dismissed the in-product prompt; do not nag again. */
  dismissed: boolean;
  /** Last time a notification was delivered successfully. */
  lastDeliveredAt?: string;
  /** Last observed authorization classification. */
  lastAuthorization?: "not_determined" | "authorized" | "denied" | "unavailable" | "unsupported";
  /** User explicitly declined / chose "Not now". */
  declinedAt?: string;
}

const PREFS_VERSION = 1;

interface StoredPrefs extends NotificationOnboardingPrefs {
  version: number;
}

export function defaultNotificationOnboardingPrefsPath(): string {
  return join(getPairMeshHome(), "notification-onboarding.json");
}

export async function loadNotificationOnboardingPrefs(
  path = defaultNotificationOnboardingPrefsPath()
): Promise<NotificationOnboardingPrefs> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    return {
      dismissed: Boolean(parsed.dismissed),
      ...(parsed.lastDeliveredAt ? { lastDeliveredAt: String(parsed.lastDeliveredAt) } : {}),
      ...(parsed.lastAuthorization
        ? {
            lastAuthorization:
              parsed.lastAuthorization as NotificationOnboardingPrefs["lastAuthorization"]
          }
        : {}),
      ...(parsed.declinedAt ? { declinedAt: String(parsed.declinedAt) } : {})
    };
  } catch {
    return { dismissed: false };
  }
}

export async function saveNotificationOnboardingPrefs(
  prefs: NotificationOnboardingPrefs,
  path = defaultNotificationOnboardingPrefsPath()
): Promise<void> {
  const stored: StoredPrefs = {
    version: PREFS_VERSION,
    dismissed: prefs.dismissed,
    ...(prefs.lastDeliveredAt ? { lastDeliveredAt: prefs.lastDeliveredAt } : {}),
    ...(prefs.lastAuthorization ? { lastAuthorization: prefs.lastAuthorization } : {}),
    ...(prefs.declinedAt ? { declinedAt: prefs.declinedAt } : {})
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

export async function markNotificationDelivered(
  path = defaultNotificationOnboardingPrefsPath()
): Promise<void> {
  const prefs = await loadNotificationOnboardingPrefs(path);
  prefs.lastDeliveredAt = new Date().toISOString();
  prefs.lastAuthorization = "authorized";
  await saveNotificationOnboardingPrefs(prefs, path);
}

export async function markNotificationPromptDismissed(
  path = defaultNotificationOnboardingPrefsPath()
): Promise<void> {
  const prefs = await loadNotificationOnboardingPrefs(path);
  prefs.dismissed = true;
  prefs.declinedAt = new Date().toISOString();
  await saveNotificationOnboardingPrefs(prefs, path);
}
