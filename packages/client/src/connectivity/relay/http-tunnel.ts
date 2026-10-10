import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { PairMeshRelayClient, RelaySendDestination } from "./client.js";

export type RelayTunnelRole = "creator" | "joiner";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);

function sanitizeForwardHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

export interface HttpTunnelMessage {
  kind: "http_request" | "http_response";
  correlationId: string;
    targetRole?: RelayTunnelRole;
    targetParticipantId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  bodyB64?: string;
}

export interface RelayHttpIngressOptions {
    acceptRole?: RelayTunnelRole;
    acceptParticipantId?: string;
}

/**
 * Local loopback HTTP façade in front of an encrypted relay client.
 * A2A ClientFactory talks to 127.0.0.1; frames on the wire remain ciphertext.
 */
export class RelayHttpIngress {
  private readonly acceptRole: RelayTunnelRole | undefined;
  private readonly acceptParticipantId: string | undefined;

  constructor(
    private readonly relayClient: PairMeshRelayClient,
    private readonly localA2aBaseUrl: string,
    acceptRoleOrOptions: RelayTunnelRole | RelayHttpIngressOptions
  ) {
    if (typeof acceptRoleOrOptions === "string") {
      this.acceptRole = acceptRoleOrOptions;
      this.acceptParticipantId = undefined;
    } else {
      this.acceptRole = acceptRoleOrOptions.acceptRole;
      this.acceptParticipantId = acceptRoleOrOptions.acceptParticipantId;
    }
  }

  start(): () => void {
    return this.relayClient.onPlaintext(async (plaintext, meta) => {
      const message = JSON.parse(new TextDecoder().decode(plaintext)) as HttpTunnelMessage;
      if (message.kind !== "http_request" || !message.path || !message.method) {
        return;
      }
      if (!this.accepts(message)) {
        return;
      }
      const replyDest: RelaySendDestination | undefined = buildReplyDest(meta);
      try {
        const target = new URL(message.path, this.localA2aBaseUrl);
        const headers = sanitizeForwardHeaders(message.headers);
        const response = await fetch(target, {
          method: message.method,
          headers,
          body: message.bodyB64 ? Buffer.from(message.bodyB64, "base64") : undefined,
          // Bound local A2A wait so half-open peers cannot pin ingress forever.
          signal: AbortSignal.timeout(3_000)
        });
        const body = Buffer.from(await response.arrayBuffer());
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) {
            responseHeaders[key] = value;
          }
        });
        const reply: HttpTunnelMessage = {
          kind: "http_response",
          correlationId: message.correlationId,
          statusCode: response.status,
          headers: responseHeaders,
          bodyB64: body.toString("base64")
        };
        await this.relayClient.sendPlaintext(
          new TextEncoder().encode(JSON.stringify(reply)),
          replyDest
        );
      } catch (error) {
        const reply: HttpTunnelMessage = {
          kind: "http_response",
          correlationId: message.correlationId,
          statusCode: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
          bodyB64: Buffer.from(
            error instanceof Error ? error.message : "relay_ingress_fetch_failed"
          ).toString("base64")
        };
        try {
          await this.relayClient.sendPlaintext(
            new TextEncoder().encode(JSON.stringify(reply)),
            replyDest
          );
        } catch {
          /* peer gone */
        }
      }
    });
  }

  private accepts(message: HttpTunnelMessage): boolean {
    if (message.targetParticipantId) {
      return (
        this.acceptParticipantId !== undefined &&
        message.targetParticipantId === this.acceptParticipantId
      );
    }
    if (message.targetRole !== undefined) {
      return this.acceptRole !== undefined && message.targetRole === this.acceptRole;
    }
    // No targeting fields — accept only when ingress has no participant filter (legacy).
    return this.acceptParticipantId === undefined;
  }
}

/** Default wait for application HTTP (A2A tasks may run long). */
export const RELAY_HTTP_APP_TIMEOUT_MS = 120_000;
export const RELAY_HTTP_TRANSPORT_PROBE_TIMEOUT_MS = 8_000;

/**
 * Typed connectivity failure when the peer route is definitively unavailable.
 * Distinct from application / coding-agent timeouts (ISSUE-03).
 */
export const PEER_TRANSPORT_UNAVAILABLE = "peer_transport_unavailable";

/**
 * Ordinary application traffic while the creator→joiner route is not yet verified.
 * Distinct from terminal `peer_transport_unavailable`.
 */
export const PEER_ROUTE_NOT_VERIFIED = "peer_route_not_verified";

export type TransportStallDecision =
  | { kind: "fail" }
  | {
      kind: "retry";
      /** Optional refreshed unicast routing before the single bounded retry. */
      sendDest?: RelaySendDestination;
    };

export type OnTransportStall = (info: {
  method: string;
  path: string;
  durationMs: number;
  attempt: number;
  sendDest?: RelaySendDestination;
}) => Promise<TransportStallDecision> | TransportStallDecision;

/**
 * Immutable verification episode captured at probe send time.
 * Results may mutate route state only when these still match the binding.
 */
export type TransportProbeEpisode = {
  episodeId: string;
  /** connectionId the probe was SENT to (not “current map at result time”). */
  sentConnectionId: string;
  /** Authenticated presence generation associated with that connection, if known. */
  presenceGeneration?: number;
};

export type OnTransportProbeResult = (info: {
  ok: boolean;
  method: string;
  path: string;
  durationMs: number;
  episodeId: string;
  sentConnectionId: string;
  presenceGeneration?: number;
}) => void;

export interface RelayHttpEgressOptions {
    targetParticipantId?: string;
  /** Unicast / channel routing for relay sendPlaintext. */
  sendDest?: RelaySendDestination;
  /** Application (non-probe) response wait timeout (default 120s). */
  requestTimeoutMs?: number;
  /** Transport probe (/health, agent-card) timeout (default 8s). */
  transportProbeTimeoutMs?: number;
  /**
   * Called when a transport probe gets no http_response within the probe deadline.
   * May request a single bounded retry after route rebind. Never used for app paths.
   */
  onTransportStall?: OnTransportStall;
  /** Fired when a transport probe settles (success or final failure). */
  onTransportProbeResult?: OnTransportProbeResult;
  /**
   * Ordinary application traffic gate (creator→joiner verified-route authority).
   * Transport probes always bypass this — verification must not deadlock.
   */
  isAppTrafficAllowed?: () => boolean;
  /** Body/reason when app traffic is gated (default peer_route_not_verified). */
  getAppTrafficDenyReason?: () => string;
  /** Optional generation snapshot for probe episodes (creator binding). */
  getProbePresenceGeneration?: () => number | undefined;
}

export function isRelayHttpTransportProbe(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") {
    return false;
  }
  const pathname = (path.split("?")[0] ?? "/").toLowerCase();
  if (pathname === "/health" || pathname.endsWith("/health")) {
    return true;
  }
  if (pathname.includes("/.well-known/")) {
    return true;
  }
  if (pathname.includes("agent-card") || pathname.endsWith("/agent.json")) {
    return true;
  }
  return false;
}

export class RelayHttpEgress {
  private server: Server | null = null;
  private port = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: {
        statusCode: number;
        headers: Record<string, string>;
        body: Buffer;
      }) => void;
      reject: (err: Error) => void;
    }
  >();
  private unsubscribe: (() => void) | null = null;
  private readonly targetParticipantId: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly transportProbeTimeoutMs: number;
  private readonly onTransportStall: OnTransportStall | undefined;
  private readonly onTransportProbeResult: OnTransportProbeResult | undefined;
  /** Mutable: joiner rekey after creator restart must refresh channelId. */
  private sendDest: RelaySendDestination | undefined;

  private readonly isAppTrafficAllowed?: () => boolean;
  private readonly getAppTrafficDenyReason?: () => string;
  private readonly getProbePresenceGeneration?: () => number | undefined;

  constructor(
    private readonly relayClient: PairMeshRelayClient,
    private readonly targetRole: RelayTunnelRole,
    options: RelayHttpEgressOptions = {}
  ) {
    this.targetParticipantId = options.targetParticipantId;
    this.sendDest = options.sendDest;
    this.requestTimeoutMs = options.requestTimeoutMs ?? RELAY_HTTP_APP_TIMEOUT_MS;
    this.transportProbeTimeoutMs =
      options.transportProbeTimeoutMs ??
      Math.min(RELAY_HTTP_TRANSPORT_PROBE_TIMEOUT_MS, this.requestTimeoutMs);
    this.onTransportStall = options.onTransportStall;
    this.onTransportProbeResult = options.onTransportProbeResult;
    this.isAppTrafficAllowed = options.isAppTrafficAllowed;
    this.getAppTrafficDenyReason = options.getAppTrafficDenyReason;
    this.getProbePresenceGeneration = options.getProbePresenceGeneration;
  }

  /** Update unicast/channel routing without rebinding the loopback listener. */
  updateSendDest(sendDest: RelaySendDestination | undefined): void {
    this.sendDest = sendDest;
  }

  /** Test hook: inspect current unicast routing (sticky-presence retarget). */
  getSendDestForTest(): RelaySendDestination | undefined {
    return this.sendDest ? { ...this.sendDest } : undefined;
  }

  /** Test hook: pending HTTP correlation waiters. */
  getPendingCountForTest(): number {
    return this.pending.size;
  }

  /**
   * Fail pending tunnel waiters promptly when the peer route is unavailable.
   * Does not replay application work — callers must not auto-retry mutations.
   */
  markRouteUnavailable(reason: string = PEER_TRANSPORT_UNAVAILABLE): void {
    const err = new Error(reason);
    for (const [correlationId, waiter] of [...this.pending.entries()]) {
      this.pending.delete(correlationId);
      try {
        waiter.reject(err);
      } catch {
        /* never throw from cleanup */
      }
    }
  }

  async listen(): Promise<string> {
    this.unsubscribe = this.relayClient.onPlaintext((plaintext) => {
      const message = JSON.parse(new TextDecoder().decode(plaintext)) as HttpTunnelMessage;
      if (message.kind !== "http_response") return;
      const waiter = this.pending.get(message.correlationId);
      if (!waiter) return;
      this.pending.delete(message.correlationId);
      waiter.resolve({
        statusCode: message.statusCode ?? 502,
        headers: message.headers ?? {},
        body: Buffer.from(message.bodyB64 ?? "", "base64")
      });
    });

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("relay_tunnel_error");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind relay HTTP egress");
    }
    this.port = address.port;
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("Relay HTTP egress closed"));
    }
    this.pending.clear();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(", ");
    }
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const transportProbe = isRelayHttpTransportProbe(method, path);

    // Ordinary app traffic requires verified route; probes always allowed (no deadlock).
    if (!transportProbe && this.isAppTrafficAllowed && !this.isAppTrafficAllowed()) {
      const reason = this.getAppTrafficDenyReason?.() ?? PEER_ROUTE_NOT_VERIFIED;
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(reason);
      return;
    }

    const baseTimeoutMs = transportProbe ? this.transportProbeTimeoutMs : this.requestTimeoutMs;
    const startedMs = Date.now();
    const probeEpisode: TransportProbeEpisode | undefined = transportProbe
      ? {
          episodeId: randomUUID(),
          sentConnectionId: this.sendDest?.toConnectionId ?? "",
          ...(typeof this.getProbePresenceGeneration?.() === "number"
            ? { presenceGeneration: this.getProbePresenceGeneration() }
            : {})
        }
      : undefined;

    let attempt = 0;
    let lastError: unknown = new Error("Relay HTTP tunnel timeout");

    while (attempt < 2) {
      attempt += 1;
      const correlationId = randomUUID();
      const message: HttpTunnelMessage = {
        kind: "http_request",
        correlationId,
        targetRole: this.targetRole,
        ...(this.targetParticipantId ? { targetParticipantId: this.targetParticipantId } : {}),
        method,
        path,
        headers: sanitizeForwardHeaders(headers),
        bodyB64: body.length > 0 ? body.toString("base64") : undefined
      };

      const responsePromise = new Promise<{
        statusCode: number;
        headers: Record<string, string>;
        body: Buffer;
      }>((resolve, reject) => {
        let settled = false;
        const settleReject = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(correlationId);
          reject(err);
        };
        const settleResolve = (value: {
          statusCode: number;
          headers: Record<string, string>;
          body: Buffer;
        }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(correlationId);
          resolve(value);
        };
        const timer = setTimeout(() => {
          settleReject(new Error("Relay HTTP tunnel timeout"));
        }, baseTimeoutMs);
        this.pending.set(correlationId, {
          resolve: settleResolve,
          reject: settleReject
        });
        // Client abort (e.g. peer-health 5s) must clear waiter — do not leave a 120s orphan.
        const onAbort = () => {
          settleReject(new Error("Relay HTTP egress request aborted"));
        };
        req.once("aborted", onAbort);
        res.once("close", () => {
          if (!res.writableEnded) {
            onAbort();
          }
        });
      });
      // Always absorb settlement — early send failures / close() must not leave
      // an orphaned rejection that terminates the background worker.
      const absorbed = responsePromise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );

      try {
        await this.relayClient.sendPlaintext(
          new TextEncoder().encode(JSON.stringify(message)),
          this.sendDest
        );
      } catch (error) {
        const waiter = this.pending.get(correlationId);
        if (waiter) {
          waiter.reject(error instanceof Error ? error : new Error("relay_tunnel_send_failed"));
        }
        await absorbed;
        lastError = error;
        break;
      }

      const settled = await absorbed;
      if (settled.ok) {
        if (transportProbe && probeEpisode) {
          this.onTransportProbeResult?.({
            ok: true,
            method,
            path,
            durationMs: Date.now() - startedMs,
            episodeId: probeEpisode.episodeId,
            sentConnectionId: probeEpisode.sentConnectionId,
            ...(probeEpisode.presenceGeneration !== undefined
              ? { presenceGeneration: probeEpisode.presenceGeneration }
              : {})
          });
        }
        res.writeHead(settled.value.statusCode, settled.value.headers);
        res.end(settled.value.body);
        return;
      }

      lastError = settled.error;
      const timedOut = settled.error instanceof Error && /timeout/i.test(settled.error.message);
      if (!transportProbe || !timedOut || attempt >= 2 || !this.onTransportStall) {
        break;
      }

      const decision = await this.onTransportStall({
        method,
        path,
        durationMs: Date.now() - startedMs,
        attempt,
        sendDest: this.sendDest ? { ...this.sendDest } : undefined
      });
      if (decision.kind !== "retry") {
        break;
      }
      if (decision.sendDest) {
        this.updateSendDest(decision.sendDest);
        // Retargeted retry: episode must describe the connection THIS attempt is sent to.
        if (probeEpisode && decision.sendDest.toConnectionId) {
          probeEpisode.sentConnectionId = decision.sendDest.toConnectionId;
        }
      }
      // Bound to a single retry — loop continues once more.
    }

    if (transportProbe && probeEpisode) {
      this.onTransportProbeResult?.({
        ok: false,
        method,
        path,
        durationMs: Date.now() - startedMs,
        episodeId: probeEpisode.episodeId,
        sentConnectionId: probeEpisode.sentConnectionId,
        ...(probeEpisode.presenceGeneration !== undefined
          ? { presenceGeneration: probeEpisode.presenceGeneration }
          : {})
      });
    }
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(lastError instanceof Error ? lastError.message : "relay_tunnel_error");
    }
  }
}

function buildReplyDest(meta: {
  fromConnectionId?: string;
  fromParticipantId?: string;
  channelId?: string;
}): RelaySendDestination | undefined {
  if (!meta.fromConnectionId && !meta.fromParticipantId && !meta.channelId) {
    return undefined;
  }
  return {
    ...(meta.fromConnectionId ? { toConnectionId: meta.fromConnectionId } : {}),
    ...(meta.fromParticipantId ? { toParticipantId: meta.fromParticipantId } : {}),
    ...(meta.channelId ? { channelId: meta.channelId } : {})
  };
}
