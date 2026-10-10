import type { ActionExecutionRecord } from "@pairmesh/protocol";
import type { LocalSessionState } from "../session/schemas.js";
import { toSafePeerMeta } from "../session/peer-view.js";
import { buildControlInboxUrl } from "../control/open-inbox.js";
import { openControlInboxInBrowser } from "../control/open-inbox.js";
import {
  buildOwnerNotificationPayload,
  shouldNotifyForStatusTransition,
  type HumanAttentionEvent,
  type HumanAttentionKind
} from "./attention.js";
import { deliverOwnerNotification, type NotificationDeliveryResult } from "./deliver.js";
import { markNotificationDelivered } from "./onboarding-prefs.js";
import {
  loadNotificationOnboardingPrefs,
  saveNotificationOnboardingPrefs
} from "./onboarding-prefs.js";

export interface OwnerPresenceOptions {
  controlBaseUrl: string;
  controlToken: string;
  /**
   * Mint a one-time exchange code for deep-links (R22-4). Prefer this over
   * embedding the long-lived controlToken in notification URLs.
   */
  mintExchangeCode?: () => { code: string; expiresAt: string };
  /** Injected for tests. */
  deliver?: typeof deliverOwnerNotification;
  openBrowser?: typeof openControlInboxInBrowser;
    openBrowserOnApproval?: boolean;
}

/**
 * Receiver-local owner presence: OS notifications + Control deep-links.
 * Presentation only — never approves.
 */
export class OwnerPresence {
  private readonly controlBaseUrl: string;
  private readonly controlToken: string;
  private readonly mintExchangeCode?: () => { code: string; expiresAt: string };
  private readonly deliver: typeof deliverOwnerNotification;
  private readonly openBrowser: typeof openControlInboxInBrowser;
  private readonly openBrowserOnApproval: boolean;
  private readonly notified = new Set<string>();

  public constructor(options: OwnerPresenceOptions) {
    this.controlBaseUrl = options.controlBaseUrl;
    this.controlToken = options.controlToken;
    this.mintExchangeCode = options.mintExchangeCode;
    this.deliver = options.deliver ?? deliverOwnerNotification;
    this.openBrowser = options.openBrowser ?? openControlInboxInBrowser;
    this.openBrowserOnApproval = options.openBrowserOnApproval ?? false;
  }

  public async handleActionTransition(input: {
    state: LocalSessionState;
    previous?: ActionExecutionRecord;
    next: ActionExecutionRecord;
  }): Promise<HumanAttentionKind | undefined> {
    const localId = input.state.localParticipant.participant.id;
    const isLocalTarget = input.next.targetParticipantId === localId;
    const kind = shouldNotifyForStatusTransition({
      previousStatus: input.previous?.status,
      nextStatus: input.next.status,
      actionType: input.next.actionType,
      isLocalTarget
    });
    if (!kind) {
      return undefined;
    }

    const dedupeKey = `${input.next.actionId}:${kind}:${input.next.status}`;
    if (this.notified.has(dedupeKey)) {
      return undefined;
    }

    const peer = resolveRequesterPeer(input.state, input.next.requesterParticipantId);
    const event: HumanAttentionEvent = {
      kind,
      actionId: input.next.actionId,
      actionType: input.next.actionType,
      status: input.next.status,
      requesterParticipantId: input.next.requesterParticipantId,
      targetParticipantId: input.next.targetParticipantId,
      ...(peer?.displayName ? { peerDisplayName: peer.displayName } : {}),
      ...(peer?.service ? { serviceLabel: peer.service } : {}),
      ...(safeSummaryFromExecution(input.next)
        ? { safeSummary: safeSummaryFromExecution(input.next) }
        : {})
    };

    const openUrl = this.mintExchangeCode
      ? buildControlInboxUrl(this.controlBaseUrl, this.mintExchangeCode().code, {
          actionId: input.next.actionId,
          view: kind === "proposal_ready" || kind === "action_failed" ? "activity" : "inbox"
        })
      : (() => {
          // Test/legacy fallback: never preferred in production (always inject mintExchangeCode).
          const base = this.controlBaseUrl.replace(/\/$/, "");
          const params = new URLSearchParams();
          params.set("token", this.controlToken);
          params.set("action", input.next.actionId);
          params.set(
            "view",
            kind === "proposal_ready" || kind === "action_failed" ? "activity" : "inbox"
          );
          return `${base}/control/web/#${params.toString()}`;
        })();
    const payload = buildOwnerNotificationPayload(event, { openUrl });
    // Delivery never opens a browser — deep-link is on notification click.
    const delivery: NotificationDeliveryResult = await this.deliver(payload);
    if (delivery.delivered) {
      // Only burn the dedupe key after success so a transient deliver failure
      // can retry on a later transition/persist of the same attention event.
      this.notified.add(dedupeKey);
      // Record success so Control Inbox stops coaching for first-use enablement.
      void markNotificationDelivered().catch(() => undefined);
    } else {
      // Operator-visible; never throw — approval path must stay intact.
      console.warn(
        `[pairmesh] OS notification not delivered (method=${delivery.method}) for ${kind} ${input.next.actionId}`
      );
      if (delivery.permissionDenied) {
        void loadNotificationOnboardingPrefs()
          .then(async (prefs) => {
            prefs.lastAuthorization = "denied";
            await saveNotificationOnboardingPrefs(prefs);
          })
          .catch(() => undefined);
      }
    }

    // Optional browser open is a separate concern and only after successful
    // delivery so a failed/suppressed notify cannot look "successful".
    if (
      kind === "approval_required" &&
      this.openBrowserOnApproval &&
      delivery.delivered &&
      payload.openUrl
    ) {
      await this.openBrowser(payload.openUrl);
    }

    return kind;
  }
}

function resolveRequesterPeer(state: LocalSessionState, requesterId: string) {
  const peer = state.peers.find((entry) => entry.participant.id === requesterId);
  if (!peer) {
    return undefined;
  }
  return toSafePeerMeta(peer);
}

function safeSummaryFromExecution(execution: ActionExecutionRecord): string | undefined {
  const summary = execution.result?.summary?.trim();
  if (summary) {
    return summary.slice(0, 120);
  }
  const instruction = execution.parameters?.instruction ?? execution.parameters?.question;
  if (typeof instruction === "string" && instruction.trim()) {
    // Truncate; never include full prompt in notification beyond short hint
    return instruction.trim().slice(0, 80);
  }
  return undefined;
}
