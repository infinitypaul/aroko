import type { ActionSafeView } from "../action/session-bridge.js";
import type { PeerInspectionResult } from "../session/manager.js";
import { formatPeerLabel } from "../session/peer-view.js";
import {
  formatActivityTimelineText,
  formatLifecycleHumanMessage
} from "../progress/activity-display.js";
import {
  formatRequesterProgressLine,
  formatRequesterProgressTimeline,
  formatRequesterTerminalOutcome
} from "./ask-intent.js";

export function presentInspectionHuman(result: PeerInspectionResult): string {
  const peer = result.safePeer
    ? formatPeerLabel(result.safePeer)
    : typeof result.peer === "string"
      ? result.peer
      : "Peer";

  if (result.completed) {
    const findingsList = Array.isArray(result.findings) ? result.findings : [];
    const findings =
      findingsList.length > 0
        ? `\n\nFindings:\n${findingsList.map((f) => `• ${f}`).join("\n")}`
        : "";
    const progress =
      "progressEvents" in result && Array.isArray(result.progressEvents)
        ? result.progressEvents
        : [];
    if (progress.length > 0) {
      const timeline = formatActivityTimelineText({
        progress,
        viewer: "requester",
        peerLabel: peer,
        status: "completed"
      });
      return `${timeline}\n\n${result.summary ?? ""}${findings}`.trim();
    }
    return `${peer}\n\n✓ Completed\n\n${result.summary ?? ""}${findings}`;
  }

  const status = "status" in result ? result.status : undefined;
  if (status === "approval_required") {
    return (
      result.message ||
      `${peer} must approve this locally before the request can run. Waiting for their approval.`
    );
  }

  const lifecycle = "lifecycle" in result ? result.lifecycle : undefined;
  const progress =
    "progressEvents" in result && Array.isArray(result.progressEvents) ? result.progressEvents : [];

  if (
    lifecycle === "requester_wait_expired" ||
    lifecycle === "peer_transport_unavailable" ||
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "timed_out"
  ) {
    const body = formatLifecycleHumanMessage({
      lifecycle,
      peerLabel: peer,
      requestId: result.requestId
    });
    if (progress.length > 0) {
      const timeline = formatActivityTimelineText({
        progress,
        viewer: "requester",
        peerLabel: peer,
        status
      });
      return `${timeline}\n\n${body}`;
    }
    return body;
  }

  if (progress.length > 0) {
    const timeline = formatActivityTimelineText({
      progress,
      viewer: "requester",
      peerLabel: peer,
      status
    });
    const footer =
      result.message && !/still (inspecting|working)/i.test(result.message)
        ? `\n\n${result.message}`
        : lifecycle === "running"
          ? `\n\n${formatLifecycleHumanMessage({ lifecycle: "running", peerLabel: peer, requestId: result.requestId })}`
          : "";
    return `${timeline}${footer}`;
  }

  return (
    result.message ||
    formatRequesterProgressTimeline({
      progress: [{ phase: "investigating" }],
      peerLabel: peer,
      status
    })
  );
}

export function presentActionHuman(view: ActionSafeView, peerLabel?: string): string {
  const peer = peerLabel ?? (view.peer ? formatPeerLabel(view.peer) : "Peer");

  const terminalLine = formatRequesterTerminalOutcome({
    status: view.status,
    peerLabel: peer,
    error: view.error
  });

  if (view.status === "completed") {
    const summary = view.summary?.trim();
    const timeline =
      view.progress.length > 0
        ? formatRequesterProgressTimeline({
            progress: view.progress,
            peerLabel: peer,
            status: view.status
          })
        : `${peer}\n\n✓ Completed`;
    return summary ? `${timeline}\n\n${summary}` : timeline;
  }

  if (
    view.status === "denied" ||
    view.status === "expired" ||
    view.status === "failed" ||
    view.status === "cancelled"
  ) {
    const timeline =
      view.progress.length > 0
        ? `${formatRequesterProgressTimeline({
            progress: view.progress,
            peerLabel: peer,
            status: view.status
          })}\n\n`
        : `${peer}\n\n`;
    return `${timeline}${terminalLine ?? formatRequesterProgressLine({ status: view.status, peerLabel: peer })}`;
  }

  if (view.status === "approval_required") {
    const timeline = formatRequesterProgressTimeline({
      progress: view.progress.length > 0 ? view.progress : [{ phase: "awaiting_owner_approval" }],
      peerLabel: peer,
      status: view.status
    });
    return `${timeline}\n\n${peer} will review the exact change in their local PairMesh Inbox.`;
  }

  if (view.progress.length > 0) {
    return formatRequesterProgressTimeline({
      progress: view.progress,
      peerLabel: peer,
      status: view.status
    });
  }

  return formatRequesterProgressLine({
    phase: view.latestProgress?.phase,
    status: view.status,
    peerLabel: peer
  });
}
