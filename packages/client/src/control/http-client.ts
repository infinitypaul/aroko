import type { CapabilityGrantPolicy, PermissionDecisionValue } from "@pairmesh/protocol";
import type {
  ControlCapabilityDefinitionView,
  ControlInviteResult,
  ControlJoinInput,
  ControlPeerView,
  ControlPermissionsView,
  ControlStatusView
} from "./types.js";

export interface ControlHttpClientOptions {
  baseUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Trusted-host Control API client (CLI / future Desktop / other local admin tools).
 * Never embed the long-lived controlToken in browser URLs or untrusted UI surfaces.
 */
export class ControlHttpClient {
  private readonly baseUrl: string;
  private readonly controlToken: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: ControlHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.controlToken = options.controlToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public getStatus(): Promise<ControlStatusView> {
    return this.request<ControlStatusView>("GET", "/control/v1/status");
  }

  /** Mint a short-lived one-time exchange code for browser Inbox deep-links (R22-4). */
  public mintExchangeCode(): Promise<{ code: string; expiresAt: string }> {
    return this.request("POST", "/control/v1/auth/mint-exchange", {});
  }

  public listPeers(): Promise<{ peers: ControlPeerView[] }> {
    return this.request("GET", "/control/v1/peers");
  }

  public getPermissions(): Promise<ControlPermissionsView> {
    return this.request("GET", "/control/v1/permissions");
  }

  public listCapabilities(): Promise<{ capabilities: ControlCapabilityDefinitionView[] }> {
    return this.request("GET", "/control/v1/capabilities");
  }

  public listAudit(limit = 50): Promise<{ events: unknown[] }> {
    return this.request("GET", `/control/v1/audit?limit=${encodeURIComponent(String(limit))}`);
  }

  public createInvite(input?: {
    initialGrants?: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>;
  }): Promise<ControlInviteResult> {
    return this.request("POST", "/control/v1/invite", input ?? {});
  }

  public join(input: ControlJoinInput): Promise<ControlStatusView> {
    return this.request("POST", "/control/v1/join", input);
  }

  public setPeerCapability(
    peer: string,
    capabilityId: string,
    policy: CapabilityGrantPolicy
  ): Promise<{ peer: string; capabilityId: string; policy: CapabilityGrantPolicy }> {
    return this.request(
      "PUT",
      `/control/v1/peers/${encodeURIComponent(peer)}/capabilities/${encodeURIComponent(capabilityId)}`,
      { policy }
    );
  }

  public decidePermission(
    permissionRequestId: string,
    decision: PermissionDecisionValue
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/control/v1/permissions/${encodeURIComponent(permissionRequestId)}/decide`,
      { decision }
    );
  }

  public listPendingActions(): Promise<{ actions: unknown[] }> {
    return this.request("GET", "/control/v1/actions/pending");
  }

  public listCollaborativeTasks(
    filter: "active" | "recent" | "all" = "active",
    limit = 50
  ): Promise<{ tasks: unknown[] }> {
    const params = new URLSearchParams({
      filter,
      limit: String(limit)
    });
    return this.request("GET", `/control/v1/tasks?${params.toString()}`);
  }

  public getCollaborativeTask(taskId: string): Promise<unknown> {
    return this.request("GET", `/control/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  public getCollaborativeTaskHistory(taskId: string): Promise<unknown> {
    return this.request("GET", `/control/v1/tasks/${encodeURIComponent(taskId)}/history`);
  }

  public listPendingRequesterInputs(): Promise<{ inputs: unknown[] }> {
    return this.request("GET", "/control/v1/tasks/pending-inputs");
  }

  public answerRequesterInput(
    inputRequestId: string,
    body: { answer: string; taskId?: string }
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/control/v1/tasks/inputs/${encodeURIComponent(inputRequestId)}/answer`,
      body
    );
  }

  public listActions(
    filter: "pending" | "active" | "recent" | "all" = "all",
    limit = 50
  ): Promise<{ actions: unknown[] }> {
    const params = new URLSearchParams({
      filter,
      limit: String(limit)
    });
    return this.request("GET", `/control/v1/actions?${params.toString()}`);
  }

  public listInspections(
    filter: "active" | "recent" | "all" = "all",
    limit = 50
  ): Promise<{ inspections: unknown[] }> {
    const params = new URLSearchParams({
      filter,
      limit: String(limit)
    });
    return this.request("GET", `/control/v1/inspections?${params.toString()}`);
  }

  public getAction(actionId: string): Promise<unknown> {
    return this.request("GET", `/control/v1/actions/${encodeURIComponent(actionId)}`);
  }

  public getInspection(requestId: string): Promise<unknown> {
    return this.request("GET", `/control/v1/inspections/${encodeURIComponent(requestId)}`);
  }

  public reviewActionProposal(actionId: string): Promise<unknown> {
    return this.request("GET", `/control/v1/actions/${encodeURIComponent(actionId)}/proposal`);
  }

  public decideAction(
    actionId: string,
    decision: "allow-once" | "allow-session" | "deny"
  ): Promise<unknown> {
    return this.request("POST", `/control/v1/actions/${encodeURIComponent(actionId)}/decide`, {
      decision
    });
  }

  public removePeer(peer: string): Promise<unknown> {
    return this.request("POST", `/control/v1/peers/${encodeURIComponent(peer)}/remove`, {});
  }

  public leave(): Promise<{ left: boolean }> {
    return this.request("POST", "/control/v1/leave", {});
  }

  public getRelayStatus(): Promise<Record<string, unknown>> {
    return this.request("GET", "/control/v1/relay");
  }

  public getRelayTrafficTrace(): Promise<Record<string, unknown>> {
    return this.request("GET", "/control/v1/relay/traffic-trace");
  }

  public resetRelayTrafficTrace(canaries?: string[]): Promise<Record<string, unknown>> {
    return this.request("POST", "/control/v1/relay/traffic-trace/reset", { canaries });
  }

  public startRelayCreator(input: {
    relayWsUrl: string;
    sessionCode: string;
    inviteSecret: string;
  }): Promise<{
    mode: string;
    role: string;
    connected: boolean;
    peerReady: boolean;
    localEndpoint?: string;
    relaySessionId?: string;
  }> {
    return this.request("POST", "/control/v1/relay/creator", input);
  }

  public getNotificationStatus(): Promise<Record<string, unknown>> {
    return this.request("GET", "/control/v1/notifications/status");
  }

  public enableNotifications(): Promise<Record<string, unknown>> {
    return this.request("POST", "/control/v1/notifications/enable", {});
  }

  public openNotificationSettings(): Promise<Record<string, unknown>> {
    return this.request("POST", "/control/v1/notifications/open-settings", {});
  }

  public dismissNotificationPrompt(): Promise<Record<string, unknown>> {
    return this.request("POST", "/control/v1/notifications/dismiss", {});
  }

  public startRelayJoiner(input: {
    relayWsUrl: string;
    sessionCode: string;
    inviteSecret: string;
  }): Promise<{
    mode: string;
    role: string;
    connected: boolean;
    peerReady: boolean;
    localEndpoint?: string;
    relaySessionId?: string;
  }> {
    return this.request("POST", "/control/v1/relay/joiner", input);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.controlToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { error: text };
      }
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? JSON.stringify((parsed as { error: unknown }).error)
          : `Control API ${method} ${path} failed (${response.status})`;
      throw new Error(message);
    }
    return parsed as T;
  }
}
