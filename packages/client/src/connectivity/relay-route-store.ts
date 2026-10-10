import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import * as z from "zod";
import {
  RelayAccessTokenSchema,
  RelayChannelIdSchema,
  RelaySessionIdSchema
} from "./relay/frames.js";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../state/store.js";

const RelayRouteChannelSchema = z.strictObject({
  peerParticipantId: z.string().trim().min(1),
  channelId: RelayChannelIdSchema
});

const RelayRouteCommonFields = {
  sessionCode: z.string().trim().min(1),
  role: z.enum(["creator", "joiner"]),
  relayWsUrl: z.string().url(),
  relaySessionId: RelaySessionIdSchema,
  relayAccessToken: RelayAccessTokenSchema
};

export const RelayRouteStateV1Schema = z.strictObject({
  version: z.literal(1),
  ...RelayRouteCommonFields
});

export const RelayRouteStateV2Schema = z.strictObject({
  version: z.literal(2),
  ...RelayRouteCommonFields,
  channels: z.array(RelayRouteChannelSchema).optional()
});

export const RelayRouteStateV3Schema = z.strictObject({
  version: z.literal(3),
  ...RelayRouteCommonFields,
  channels: z.array(RelayRouteChannelSchema).optional(),
  /**
   * Stable joiner wire presence (`join_…`). Survives reconnect; distinct from
   * socket `connectionId`. Creator omits (uses `relay_creator`).
   */
  relayPresenceId: z.string().trim().min(8).max(120).optional(),
  /** Monotonic presence generation; increments on each joiner restore/reconnect. */
  presenceGeneration: z.number().int().nonnegative().optional(),
    authorizedRelayAccessTokens: z.array(RelayAccessTokenSchema).max(32).optional()
});

export const RelayRouteStateSchema = z.union([
  RelayRouteStateV1Schema,
  RelayRouteStateV2Schema,
  RelayRouteStateV3Schema
]);

export type RelayRouteState = z.infer<typeof RelayRouteStateSchema>;
export type RelayRouteStateV1 = z.infer<typeof RelayRouteStateV1Schema>;
export type RelayRouteStateV2 = z.infer<typeof RelayRouteStateV2Schema>;
export type RelayRouteStateV3 = z.infer<typeof RelayRouteStateV3Schema>;

export function relayRouteFileFromStateFile(stateFilePath: string): string {
  return join(dirname(resolve(stateFilePath)), "relay-route.json");
}

export async function loadRelayRoute(routeFilePath: string): Promise<RelayRouteState | null> {
  let raw: string;
  try {
    raw = await readFile(routeFilePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    return RelayRouteStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveRelayRoute(routeFilePath: string, state: RelayRouteState): Promise<void> {
  const validated = RelayRouteStateSchema.parse(state);
  const directory = dirname(routeFilePath);
  await mkdir(directory, { recursive: true, mode: STATE_DIRECTORY_MODE });
  await restrictMode(directory, STATE_DIRECTORY_MODE);

  const tempPath = `${routeFilePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: STATE_FILE_MODE
  });
  await restrictMode(tempPath, STATE_FILE_MODE);
  await rename(tempPath, routeFilePath);
  await restrictMode(routeFilePath, STATE_FILE_MODE);
}

export async function clearRelayRoute(routeFilePath: string): Promise<void> {
  try {
    await rm(routeFilePath, { force: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

/**
 * Append a joiner attach token to the creator route so wipe/restore can
 * re-authorize it. Idempotent; no-op when route missing or not creator.
 */
export async function rememberAuthorizedRelayAccessToken(
  routeFilePath: string,
  token: string
): Promise<void> {
  const route = await loadRelayRoute(routeFilePath);
  if (!route || route.role !== "creator") {
    return;
  }
  const parsed = RelayAccessTokenSchema.safeParse(token);
  if (!parsed.success) {
    return;
  }
  const existing =
    route.version === 3 && Array.isArray(route.authorizedRelayAccessTokens)
      ? route.authorizedRelayAccessTokens
      : [];
  if (existing.includes(parsed.data) || route.relayAccessToken === parsed.data) {
    return;
  }
  const next: RelayRouteState = {
    version: 3,
    sessionCode: route.sessionCode,
    role: "creator",
    relayWsUrl: route.relayWsUrl,
    relaySessionId: route.relaySessionId,
    relayAccessToken: route.relayAccessToken,
    ...("channels" in route && route.channels ? { channels: route.channels } : {}),
    authorizedRelayAccessTokens: [...existing, parsed.data].slice(-32)
  };
  await saveRelayRoute(routeFilePath, next);
}

async function restrictMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, mode);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
