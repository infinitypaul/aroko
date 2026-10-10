import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PairMeshErrorSchema, type CapabilityGrantPolicy } from "@pairmesh/protocol";
import { ControlPlane } from "./service.js";
import { controlTokensEqual } from "./token.js";
import { ControlExchangeStore } from "./exchange.js";
import { serveControlWebAsset } from "./web-static.js";
import {
  dismissNotificationOnboardingPrompt,
  getNotificationPermissionSnapshot,
  openNotificationSettings,
  requestNotificationPermission
} from "../notify/permission.js";

export const CONTROL_API_PREFIX = "/control/v1";
export const CONTROL_BIND_HOST = "127.0.0.1";
export const CONTROL_MAX_JSON_BODY_BYTES = 1_048_576;

export class ControlBodyTooLargeError extends Error {
  public readonly statusCode = 413;
  public constructor() {
    super("Control request body exceeds size limit.");
    this.name = "ControlBodyTooLargeError";
  }
}

export interface ControlHttpServerOptions {
  controlPlane: ControlPlane;
  controlToken: string;
  /** Defaults to an ephemeral free port on loopback. */
  port?: number;
  host?: string;
  /** Test override for max JSON body bytes. */
  maxJsonBodyBytes?: number;
}

export interface ControlHttpServer {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  /** Mint a one-time exchange code for browser deep-links (same process). */
  mintExchangeCode: () => { code: string; expiresAt: string };
}

/**
 * Localhost-only human administration HTTP surface. Never mounted on the A2A
 * Express app (which may bind an overlay IP).
 */
export async function startControlHttpServer(
  options: ControlHttpServerOptions
): Promise<ControlHttpServer> {
  const host = options.host ?? CONTROL_BIND_HOST;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Control HTTP server must bind loopback only (got ${host}).`);
  }

  const exchangeStore = new ControlExchangeStore();
  const maxBody = options.maxJsonBodyBytes ?? CONTROL_MAX_JSON_BODY_BYTES;
  let boundPort = options.port ?? 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      plane: options.controlPlane,
      expectedToken: options.controlToken,
      exchangeStore,
      boundPort,
      maxBodyBytes: maxBody
    });
  });

  boundPort = await listen(server, host, options.port);

  return {
    host,
    port: boundPort,
    baseUrl: `http://${host}:${boundPort}`,
    mintExchangeCode: () => exchangeStore.mint(options.controlToken),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

function listen(server: Server, host: string, preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort ?? 0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Control server failed to bind a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    plane: ControlPlane;
    expectedToken: string;
    exchangeStore: ControlExchangeStore;
    boundPort: number;
    maxBodyBytes: number;
  }
): Promise<void> {
  const { plane, expectedToken, exchangeStore, boundPort, maxBodyBytes } = ctx;
  try {
    const method = req.method?.toUpperCase() ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (method === "OPTIONS") {
      // No Access-Control-* — browsers cannot read cross-origin Control responses.
      sendJson(res, 204, null);
      return;
    }

    if (method === "GET" && isControlWebPath(path)) {
      // Keep /control/web and /control/web/ equivalent; prefer trailing slash so
      // any remaining relative asset URLs resolve under /control/web/.
      if (path === "/control/web") {
        const redirectTo = `/control/web/${url.search}${url.hash}`;
        res.statusCode = 302;
        res.setHeader("Location", redirectTo);
        res.end();
        return;
      }
      const subPath = path === "/control/web/" ? "" : path.slice("/control/web/".length);
      const served = await serveControlWebAsset(subPath, res);
      if (served) {
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    // DNS rebinding / Host header: Control API only accepts loopback Host.
    if (!isAllowedControlHost(req.headers.host, boundPort)) {
      sendJson(res, 400, { error: "Invalid Host" });
      return;
    }

    // R22-4: one-time exchange — no Bearer; Origin must be loopback when present.
    if (method === "POST" && path === `${CONTROL_API_PREFIX}/auth/exchange`) {
      if (!isAllowedBrowserOrigin(req.headers.origin, boundPort)) {
        sendJson(res, 403, { error: "Forbidden origin" });
        return;
      }
      const body = (await readJsonBody(req, maxBodyBytes)) as { code?: unknown };
      const code = typeof body.code === "string" ? body.code : "";
      const token = exchangeStore.redeem(code);
      if (!token) {
        sendJson(res, 401, { error: "Invalid or expired exchange code" });
        return;
      }
      sendJson(res, 200, { controlToken: token });
      return;
    }

    if (!authorize(req, expectedToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Mint exchange code (CLI / trusted Bearer clients only).
    if (method === "POST" && path === `${CONTROL_API_PREFIX}/auth/mint-exchange`) {
      const minted = exchangeStore.mint(expectedToken);
      sendJson(res, 200, minted);
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/notifications/status`) {
      sendJson(res, 200, await getNotificationPermissionSnapshot());
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/notifications/enable`) {
      sendJson(res, 200, await requestNotificationPermission());
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/notifications/open-settings`) {
      const opened = await openNotificationSettings();
      sendJson(res, 200, { ...opened, ...(await getNotificationPermissionSnapshot()) });
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/notifications/dismiss`) {
      sendJson(res, 200, await dismissNotificationOnboardingPrompt());
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/status`) {
      sendJson(res, 200, await plane.getStatus());
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/peers`) {
      sendJson(res, 200, { peers: await plane.listPeers() });
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/permissions`) {
      sendJson(res, 200, await plane.getPermissions());
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/capabilities`) {
      sendJson(res, 200, { capabilities: plane.listCapabilities() });
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/audit`) {
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 50;
      sendJson(res, 200, {
        events: await plane.listAudit(
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50
        )
      });
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/invite`) {
      const body = await readJsonBody(req, maxBodyBytes);
      const initialGrants = parseInitialGrants(body);
      sendJson(res, 200, await plane.createInvite(initialGrants ? { initialGrants } : undefined));
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/join`) {
      const body = (await readJsonBody(req, maxBodyBytes)) as Record<string, unknown>;
      sendJson(
        res,
        200,
        await plane.join({
          ...(typeof body.sessionCode === "string" ? { sessionCode: body.sessionCode } : {}),
          ...(typeof body.peerUrl === "string" ? { peerUrl: body.peerUrl } : {}),
          ...(typeof body.inviteSecret === "string" ? { inviteSecret: body.inviteSecret } : {}),
          ...(typeof body.joinCommand === "string" ? { joinCommand: body.joinCommand } : {}),
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.agentUrl === "string" ? { agentUrl: body.agentUrl } : {})
        })
      );
      return;
    }

    const capabilityMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/peers/([^/]+)/capabilities/([^/]+)$`)
    );
    if (method === "PUT" && capabilityMatch) {
      const peer = decodeURIComponent(capabilityMatch[1]!);
      const capabilityId = decodeURIComponent(capabilityMatch[2]!);
      const body = (await readJsonBody(req, maxBodyBytes)) as { policy?: CapabilityGrantPolicy };
      if (!body.policy) {
        sendJson(res, 400, { error: "policy is required" });
        return;
      }
      sendJson(res, 200, await plane.setPeerCapability(peer, capabilityId, body.policy));
      return;
    }

    const decideMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/permissions/([^/]+)/decide$`)
    );
    if (method === "POST" && decideMatch) {
      const permissionRequestId = decodeURIComponent(decideMatch[1]!);
      const body = (await readJsonBody(req, maxBodyBytes)) as {
        decision?: "allow-once" | "allow-session" | "deny";
      };
      if (
        body.decision !== "allow-once" &&
        body.decision !== "allow-session" &&
        body.decision !== "deny"
      ) {
        sendJson(res, 400, { error: "decision must be allow-once | allow-session | deny" });
        return;
      }
      sendJson(res, 200, await plane.decidePermission(permissionRequestId, body.decision));
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/actions/pending`) {
      sendJson(res, 200, { actions: await plane.listPendingActions() });
      return;
    }

    // R5-7 collaborative tasks — place before overly-generic matchers.
    if (method === "GET" && path === `${CONTROL_API_PREFIX}/tasks/pending-inputs`) {
      sendJson(res, 200, { inputs: await plane.listPendingRequesterInputs() });
      return;
    }

    const inputAnswerMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/tasks/inputs/([^/]+)/answer$`)
    );
    if (method === "POST" && inputAnswerMatch) {
      const inputRequestId = decodeURIComponent(inputAnswerMatch[1]!);
      const body = (await readJsonBody(req, maxBodyBytes)) as {
        answer?: unknown;
        taskId?: unknown;
      };
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!answer) {
        sendJson(res, 400, { error: "answer is required" });
        return;
      }
      sendJson(
        res,
        200,
        await plane.answerRequesterInput(inputRequestId, {
          answer,
          ...(typeof body.taskId === "string" && body.taskId.trim()
            ? { taskId: body.taskId.trim() }
            : {})
        })
      );
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/tasks`) {
      const filterRaw = url.searchParams.get("filter") ?? "active";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 50;
      const filter =
        filterRaw === "active" || filterRaw === "recent" || filterRaw === "all"
          ? filterRaw
          : "active";
      sendJson(res, 200, {
        tasks: await plane.listCollaborativeTasks(
          filter,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
        )
      });
      return;
    }

    const taskHistoryMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/tasks/([^/]+)/history$`)
    );
    if (method === "GET" && taskHistoryMatch) {
      const taskId = decodeURIComponent(taskHistoryMatch[1]!);
      sendJson(res, 200, await plane.getCollaborativeTaskHistory(taskId));
      return;
    }

    const taskGetMatch = path.match(new RegExp(`^${CONTROL_API_PREFIX}/tasks/([^/]+)$`));
    if (method === "GET" && taskGetMatch) {
      const taskId = decodeURIComponent(taskGetMatch[1]!);
      sendJson(res, 200, await plane.getCollaborativeTask(taskId));
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/actions`) {
      const filterRaw = url.searchParams.get("filter") ?? "all";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 50;
      const filter =
        filterRaw === "pending" ||
        filterRaw === "active" ||
        filterRaw === "recent" ||
        filterRaw === "all"
          ? filterRaw
          : "all";
      sendJson(res, 200, {
        actions: await plane.listActions(
          filter,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
        )
      });
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/inspections`) {
      const filterRaw = url.searchParams.get("filter") ?? "all";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 50;
      const filter =
        filterRaw === "active" || filterRaw === "recent" || filterRaw === "all" ? filterRaw : "all";
      sendJson(res, 200, {
        inspections: await plane.listInspections(
          filter,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
        )
      });
      return;
    }

    const inspectionGetMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/inspections/([^/]+)$`)
    );
    if (method === "GET" && inspectionGetMatch) {
      const requestId = decodeURIComponent(inspectionGetMatch[1]!);
      sendJson(res, 200, await plane.getInspection(requestId));
      return;
    }

    const actionProposalMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/actions/([^/]+)/proposal$`)
    );
    if (method === "GET" && actionProposalMatch) {
      const actionId = decodeURIComponent(actionProposalMatch[1]!);
      sendJson(res, 200, await plane.reviewActionProposal(actionId));
      return;
    }

    const actionDecideMatch = path.match(
      new RegExp(`^${CONTROL_API_PREFIX}/actions/([^/]+)/decide$`)
    );
    if (method === "POST" && actionDecideMatch) {
      const actionId = decodeURIComponent(actionDecideMatch[1]!);
      const body = (await readJsonBody(req, maxBodyBytes)) as {
        decision?: "allow-once" | "allow-session" | "deny";
      };
      if (
        body.decision !== "allow-once" &&
        body.decision !== "allow-session" &&
        body.decision !== "deny"
      ) {
        sendJson(res, 400, { error: "decision must be allow-once | allow-session | deny" });
        return;
      }
      sendJson(res, 200, await plane.approveAction(actionId, body.decision));
      return;
    }

    const actionGetMatch = path.match(new RegExp(`^${CONTROL_API_PREFIX}/actions/([^/]+)$`));
    if (method === "GET" && actionGetMatch) {
      const actionId = decodeURIComponent(actionGetMatch[1]!);
      sendJson(res, 200, await plane.getAction(actionId));
      return;
    }

    const removeMatch = path.match(new RegExp(`^${CONTROL_API_PREFIX}/peers/([^/]+)/remove$`));
    if (method === "POST" && removeMatch) {
      const peer = decodeURIComponent(removeMatch[1]!);
      sendJson(res, 200, await plane.removePeer(peer));
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/leave`) {
      sendJson(res, 200, await plane.leave());
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/relay`) {
      sendJson(res, 200, plane.getRelayStatus());
      return;
    }

    if (method === "GET" && path === `${CONTROL_API_PREFIX}/relay/traffic-trace`) {
      sendJson(res, 200, plane.getRelayTrafficTrace());
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/relay/traffic-trace/reset`) {
      const body = (await readJsonBody(req, maxBodyBytes)) as { canaries?: string[] };
      plane.resetRelayTrafficTrace(
        Array.isArray(body.canaries) ? body.canaries.map(String) : undefined
      );
      sendJson(res, 200, plane.getRelayTrafficTrace());
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/relay/creator`) {
      const body = (await readJsonBody(req, maxBodyBytes)) as Record<string, unknown>;
      sendJson(
        res,
        200,
        await plane.startRelayCreator({
          relayWsUrl: String(body.relayWsUrl ?? ""),
          sessionCode: String(body.sessionCode ?? ""),
          inviteSecret: String(body.inviteSecret ?? "")
        })
      );
      return;
    }

    if (method === "POST" && path === `${CONTROL_API_PREFIX}/relay/joiner`) {
      const body = (await readJsonBody(req, maxBodyBytes)) as Record<string, unknown>;
      sendJson(
        res,
        200,
        await plane.startRelayJoiner({
          relayWsUrl: String(body.relayWsUrl ?? ""),
          sessionCode: String(body.sessionCode ?? ""),
          inviteSecret: String(body.inviteSecret ?? "")
        })
      );
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof ControlBodyTooLargeError) {
      sendJson(res, 413, { error: "Payload Too Large" });
      return;
    }
    if (PairMeshErrorSchema.safeParse(error).success) {
      sendJson(res, 400, { error });
      return;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal control error"
    });
  }
}

function isControlWebPath(path: string): boolean {
  return path === "/control/web" || path.startsWith("/control/web/");
}

function isAllowedControlHost(hostHeader: string | undefined, boundPort: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostHeader.trim().toLowerCase();
  const port = String(boundPort);
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function isAllowedBrowserOrigin(
  originHeader: string | string[] | undefined,
  boundPort: number
): boolean {
  if (originHeader === undefined) {
    // Non-browser / same-origin edge cases: Host check already enforced.
    return true;
  }
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") {
      return false;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
      return false;
    }
    const port = url.port || (url.protocol === "http:" ? "80" : "443");
    return port === String(boundPort);
  } catch {
    return false;
  }
}

function authorize(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) {
    return false;
  }
  return controlTokensEqual(match[1], expectedToken);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  if (body === null) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      throw new ControlBodyTooLargeError();
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.byteLength;
    if (total > maxBytes) {
      req.destroy();
      throw new ControlBodyTooLargeError();
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

function parseInitialGrants(
  body: unknown
): Array<{ capabilityId: string; policy: CapabilityGrantPolicy }> | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const grants = (body as { initialGrants?: unknown }).initialGrants;
  if (!Array.isArray(grants)) {
    return undefined;
  }
  return grants.map((entry) => {
    const row = entry as { capabilityId?: string; policy?: CapabilityGrantPolicy };
    return {
      capabilityId: String(row.capabilityId ?? ""),
      policy: row.policy as CapabilityGrantPolicy
    };
  });
}
