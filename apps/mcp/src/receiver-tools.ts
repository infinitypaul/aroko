import { McpServer } from "@modelcontextprotocol/server";
import {
  buildControlInboxUrl,
  enrichActionForControlInbox,
  latestOwnerActivityLabel,
  openControlInboxInBrowser,
  readRuntimeInfo,
  summarizeOwnerActivity,
  type SessionManager
} from "@pairmesh/client";
import * as z from "zod";
import { runToolHandler, toolSuccess } from "./errors.js";

export function registerReceiverPairMeshTools(
  server: McpServer,
  sessionManager: SessionManager,
  options?: { workspace?: string }
): void {
  const workspace = options?.workspace;

  server.registerTool(
    "pairmesh_list_requests",
    {
      description:
        "List PairMesh requests on this machine (Kelvin's receiver). " +
        "Use filter=pending for approvals waiting, filter=active for work in progress " +
        '(answers "Any PairMesh requests?" / "What is PairMesh doing?"). ' +
        "Returns requester/service labels, coarse status, and latest activity label. " +
        "Does not approve. Follow up with pairmesh_show_request for the activity timeline.",
      inputSchema: z.object({
        filter: z
          .enum(["pending", "active", "recent", "all"])
          .optional()
          .describe("Default pending (needs approval). Use active for in-progress worker activity.")
      })
    },
    async ({ filter }) =>
      runToolHandler(
        async () => {
          const views = await sessionManager.listReceiverActions(filter ?? "pending", 50);
          return {
            requests: views.map((view) => {
              const enriched = enrichActionForControlInbox(view);
              const latestLabel = latestOwnerActivityLabel(enriched.progress);
              return {
                actionLabel: enriched.actionLabel,
                status: enriched.status,
                peer: enriched.peer
                  ? {
                      displayName: enriched.peer.displayName,
                      ...(enriched.peer.service ? { service: enriched.peer.service } : {})
                      // participantId omitted from list text path — keep for tool follow-up only
                    }
                  : undefined,
                peerParticipantId: enriched.peer?.participantId,
                providerDisplayName: enriched.providerDisplayName,
                requestSummary: enriched.requestSummary,
                needsApproval: enriched.needsApproval,
                reviewRequired: enriched.needsApproval || enriched.status === "approval_required",
                latestActivity: latestLabel,
                latestProgress: enriched.latestProgress
                  ? {
                      phase: enriched.latestProgress.phase,
                      ...(enriched.latestProgress.activityKind
                        ? { activityKind: enriched.latestProgress.activityKind }
                        : {}),
                      ...(latestLabel ? { label: latestLabel } : {}),
                      ...(enriched.latestProgress.message
                        ? { message: enriched.latestProgress.message }
                        : {})
                    }
                  : undefined,
                // Internal id for follow-up show/open tools only — humans use Inbox UI.
                actionId: enriched.actionId,
                updatedAt: enriched.updatedAt
              };
            })
          };
        },
        (result) => {
          if (result.requests.length === 0) {
            return toolSuccess(result, "No PairMesh requests in this filter.");
          }
          const lines = result.requests.map((row) => {
            const peer = row.peer?.displayName ?? "Peer";
            const service = row.peer?.service ? ` · ${row.peer.service}` : "";
            const activity = row.latestActivity ? ` — ${row.latestActivity}` : "";
            const review = row.reviewRequired ? " [review required]" : "";
            return `${peer}${service}: ${row.actionLabel} (${row.status})${activity}${review}`;
          });
          return toolSuccess(result, `PairMesh requests:\n${lines.join("\n")}`);
        }
      )
  );

  server.registerTool(
    "pairmesh_show_request",
    {
      description:
        "Show one PairMesh request with a bounded recent activity timeline from the " +
        "isolated PairMesh worker (canonical ProgressEvents — file reads, searches, " +
        'proposal prep). Answers "What\'s PairMesh doing?" / "What files has the worker ' +
        'looked at?" / "Is the proposal ready?" after pairmesh_list_requests. ' +
        "Returns at most ~15 recent events by default (max 20). " +
        "Does not approve or mutate. When review is required, use pairmesh_open_inbox.",
      inputSchema: z.object({
        actionId: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe("Action id from pairmesh_list_requests"),
        activityLimit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Recent activity event bound (default 15, max 20)")
      })
    },
    async ({ actionId, activityLimit }) =>
      runToolHandler(
        async () => {
          const view = await sessionManager.getAction(actionId);
          const enriched = enrichActionForControlInbox(view);
          const summary = summarizeOwnerActivity({
            progress: enriched.progress,
            status: enriched.status,
            needsApproval: enriched.needsApproval,
            ...(activityLimit !== undefined ? { activityLimit } : {})
          });
          return {
            actionLabel: enriched.actionLabel,
            status: enriched.status,
            peer: enriched.peer
              ? {
                  displayName: enriched.peer.displayName,
                  ...(enriched.peer.service ? { service: enriched.peer.service } : {})
                }
              : undefined,
            providerDisplayName: enriched.providerDisplayName,
            requestSummary: enriched.requestSummary,
            needsApproval: enriched.needsApproval,
            reviewRequired: summary.reviewRequired,
            proposalReady: summary.proposalReady,
            coarseState: summary.coarseState,
            activityBound: summary.activityBound,
            activityTotal: summary.activityTotal,
            activityTruncated: summary.activityTruncated,
            activity: summary.activity,
            actionId: enriched.actionId,
            openReviewHint: summary.reviewRequired
              ? "Proposal/review needs human attention — call pairmesh_open_inbox with this actionId."
              : undefined
          };
        },
        (result) => {
          const peer = result.peer?.displayName ?? "Peer";
          const service = result.peer?.service ? ` · ${result.peer.service}` : "";
          const activity =
            result.activity.length === 0
              ? "No progress events yet."
              : result.activity.map((event) => `- ${event.label}`).join("\n");
          const trunc = result.activityTruncated
            ? `\n(Showing last ${result.activityBound} of ${result.activityTotal} events.)`
            : "";
          const review = result.reviewRequired
            ? "\nReview required — open PairMesh Inbox to Approve Once / Deny (Claude cannot approve)."
            : result.proposalReady
              ? "\nProposal ready."
              : "";
          return toolSuccess(
            result,
            `${peer}${service}: ${result.actionLabel} (${result.status})\n` +
              `State: ${result.coarseState}\n` +
              `${result.requestSummary ?? ""}\n` +
              `Recent activity:\n${activity}${trunc}${review}`
          );
        }
      )
  );

  server.registerTool(
    "pairmesh_show_proposal",
    {
      description:
        "Show the exact proposal summary/stats/paths for a PairMesh action when available. " +
        "Does not approve. Prefer opening Inbox for full diff review. " +
        "When the pending item is repository.edit (apply), actionId is that apply request; " +
        "proposalActionId is the earlier change.propose that authored the same artifact — " +
        "different ids with the same artifact/diff is expected, not a mismatch.",
      inputSchema: z.object({
        actionId: z.string().trim().min(1).max(80)
      })
    },
    async ({ actionId }) =>
      runToolHandler(
        async () => {
          const proposal = await sessionManager.reviewActionProposal(actionId);
          return {
            summary: proposal.summary,
            stats: proposal.stats,
            affectedPaths: proposal.affectedPaths,
            provider: proposal.provider,
            // Echo the requested id (often the pending apply). Artifact body keeps propose id.
            actionId,
            proposalActionId: proposal.actionId,
            artifactId: proposal.artifactId,
            contentHash: proposal.contentHash,
            sameArtifactLinked:
              actionId !== proposal.actionId
                ? ("apply_and_propose_share_this_artifact" as const)
                : ("requested_action_is_propose" as const),
            // Diff available for human Inbox — keep MCP text summary-first; include truncated hint only.
            hasUnifiedDiff: Boolean(proposal.unifiedDiff),
            unifiedDiffPreview: proposal.unifiedDiff.slice(0, 2000)
          };
        },
        (result) => {
          const idNote =
            result.sameArtifactLinked === "apply_and_propose_share_this_artifact"
              ? `\nNote: pending apply is ${result.actionId}; proposal authored under ${result.proposalActionId} — same artifact/diff.`
              : "";
          return toolSuccess(
            result,
            `Proposal: ${result.summary}\nFiles: ${result.stats.filesChanged} (+${result.stats.additions}/-${result.stats.deletions})\nPaths: ${result.affectedPaths.join(", ")}${idNote}\nOpen PairMesh Inbox to Approve Once / Deny.`
          );
        }
      )
  );

  server.registerTool(
    "pairmesh_open_inbox",
    {
      description:
        "Open the local PairMesh Control Inbox (or a specific request) in the browser for human review. " +
        'Use when proposal is ready / review required ("Open the review."). ' +
        "Human Approves Once / Denies there — this tool never approves.",
      inputSchema: z.object({
        actionId: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe("Optional action id to deep-link review"),
        view: z.enum(["inbox", "activity", "history"]).optional()
      })
    },
    async ({ actionId, view }) =>
      runToolHandler(
        async () => {
          const runtime = workspace ? await readRuntimeInfo(workspace) : null;
          if (!runtime?.controlUrl || !runtime.controlToken) {
            return {
              opened: false,
              message:
                "PairMesh Control is not running. Start with `pairmesh start`, then open Inbox."
            };
          }
          const url = buildControlInboxUrl(runtime.controlUrl, runtime.controlToken, {
            ...(actionId ? { actionId } : {}),
            ...(view ? { view } : actionId ? { view: "inbox" as const } : {})
          });
          const opened = await openControlInboxInBrowser(url);
          return {
            opened,
            controlUrl: `${runtime.controlUrl}/control/web`,
            ...(actionId ? { actionId } : {}),
            message: opened
              ? "Opened local PairMesh Inbox. Approve Once / Deny only in that UI."
              : `Could not launch browser. Open: ${runtime.controlUrl}/control/web`
          };
        },
        (result) => toolSuccess(result, result.message)
      )
  );
}
