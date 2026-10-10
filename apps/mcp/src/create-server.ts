import { McpServer } from "@modelcontextprotocol/server";
import { formatInspectionCompletedText, type SessionManager } from "@pairmesh/client";
import * as z from "zod";
import { runToolHandler, toolSuccess } from "./errors.js";
import { registerReceiverPairMeshTools } from "./receiver-tools.js";
import {
  askPairMeshPeer,
  askPairMeshNatural,
  cancelPairMeshAction,
  cancelPairMeshInspection,
  closePairMeshThread,
  followUpPairMeshInspection,
  getPairMeshActionStatus,
  getPairMeshInspectionStatus,
  getPairMeshPeerHealth,
  getPairMeshStatus,
  getPairMeshThread,
  listPairMeshPeers,
  listPairMeshThreads,
  proposePairMeshChange,
  requestPairMeshApply,
  runPairMeshTests,
  executePairMeshProcess,
  sendPairMeshMessage,
  waitForPairMeshAction,
  waitForPairMeshInspection,
  type PairMeshAskPeerResult,
  type PairMeshFollowUpResult,
  type PairMeshListPeersResult,
  type PairMeshListThreadsResult,
  type PairMeshSendResult,
  type PairMeshStatusResult
} from "./tools/handlers.js";

export const PAIRMESH_MCP_SERVER_NAME = "pairmesh";
export const PAIRMESH_MCP_SERVER_VERSION = "0.5.0";

const ASK_PEER_DESCRIPTION =
  "Start a read-only inspection by asking exactly one peer's coding agent a question. " +
  "Prefer pairmesh_ask for the everyday natural path (resolve + send + wait + human progress). " +
  "Never broadcasts — targets a single peer selected by displayName, unique service label, " +
  '"DisplayName · service", or participantId. ' +
  "Do not invent peers; call pairmesh_list_peers first if unsure. Membership ≠ paired ≠ reachable; unpaired peers return authentication_required. " +
  "May return the answer immediately, a working handle while remote work continues, " +
  "or approval_required when the peer must approve the capability locally. " +
  "If still working, continue with pairmesh_wait_for_inspection (same requestId). " +
  "If approval_required, do NOT re-pair, do NOT run PairMesh setup, and do NOT start a new ask with a different question — wait for the peer's local approval, then ask the same question again to resume the same requestId.";

const ASK_NATURAL_DESCRIPTION =
  "Everyday requester collaboration path: resolve a human peer/service label, send inspect or propose, " +
  "wait for safe progress, and return a human-readable result. " +
  "intent is REQUIRED: use inspect for check/investigate/why; use propose only when the user explicitly wants a change suggestion. " +
  "Never invent intent — do not turn an informational ask into propose. " +
  "propose never auto-applies; the peer human Approves Once in their local Inbox. " +
  "There is no MCP approve/deny tool. Prefer this over chaining low-level ask_peer/propose/wait tools. " +
  "On peer ambiguity, present the numbered choices to the user — never pick silently.";

const LIST_PEERS_DESCRIPTION =
  "Discover collaboration members in the active PairMesh session. " +
  "Membership ≠ paired ≠ reachable — use relationship and connectivity fields. " +
  "Prefer unique service labels or DisplayName · service; use participantId when names collide. Returns safe metadata only (no secrets).";

const PEER_SELECTOR_DESCRIBE =
  'Exactly one peer: displayName, unique service label, "DisplayName · service", or participantId from pairmesh_list_peers';

const FOLLOW_UP_DESCRIPTION =
  "Ask a new follow-up question in an existing inspection thread (new requestId, same thread). " +
  "If still working, continue with pairmesh_wait_for_inspection — do not re-ask.";

const WAIT_FOR_INSPECTION_DESCRIPTION =
  "Continue observing an in-flight inspection until it completes or the bounded wait expires. " +
  "Use the same requestId from ask/follow-up. If still working, call again. Does not start new work.";

const INSPECTION_STATUS_DESCRIPTION =
  "Check current status of an inspection without waiting. Safe recovery after interruption. Does not start new work.";

const CANCEL_INSPECTION_DESCRIPTION =
  "Cancel an in-flight inspection on the initiator side. Prefer wait/status unless the user wants to stop.";

const PROPOSE_CHANGE_DESCRIPTION =
  "Request a change.propose action on exactly one peer (same single-peer targeting as pairmesh_ask_peer). " +
  "Produces a proposal artifact only — does not apply or mutate the peer working tree. " +
  "Reuse the returned actionId with pairmesh_action_status / pairmesh_wait_for_action; never invent a new actionId.";

const REQUEST_APPLY_DESCRIPTION =
  "Request repository.edit (apply-exact) on exactly one peer for a content-bound proposal artifact. " +
  "May return approval_required — wait for the peer's local human approval; do NOT re-pair; there is no MCP approve tool. " +
  "Reuse the same actionId for status/wait. Never starts a different apply under a new id.";

const RUN_TESTS_DESCRIPTION =
  "Request tests.run on exactly one peer by receiver-owned profile name only. " +
  "Do not pass executable, args, cwd, or env — those are receiver-controlled. " +
  "Reuse the returned actionId with status/wait tools.";

const EXECUTE_PROCESS_DESCRIPTION =
  "Request process.execute on exactly one peer: structured executable basename + args only (no shell). " +
  "Do not pass command strings, shell flags, env, stdin, TTY, or approval. " +
  "Peer human must Approve once locally. Reuse the returned actionId with status/wait tools.";

const ACTION_STATUS_DESCRIPTION =
  "Check current status of a controlled action without starting new work. Use the same actionId from propose/apply/run_tests.";

const WAIT_FOR_ACTION_DESCRIPTION =
  "Continue observing an in-flight controlled action until it completes or the bounded wait expires. " +
  "Use the same actionId — does not create a new action. If still working or awaiting approval, call again.";

const CANCEL_ACTION_DESCRIPTION =
  "Cancel a controlled action (local receiver cancel or remote peer cancel as appropriate). Prefer wait/status unless the user wants to stop.";

function presentInspectionIds(result: {
  requestId: string;
  threadId: string;
  permissionRequestId?: string;
}): string {
  const parts = [`requestId ${result.requestId}`, `threadId ${result.threadId}`];
  if (result.permissionRequestId) {
    parts.push(`permissionRequestId ${result.permissionRequestId}`);
  }
  return parts.join("; ");
}

function presentAskOrFollowUp(result: PairMeshAskPeerResult | PairMeshFollowUpResult): string {
  const ids = presentInspectionIds(result);
  if (!result.completed) {
    if (result.status === "approval_required") {
      const base =
        result.message ??
        `${result.peer} must approve this capability locally before the request can run. Do not re-pair or run PairMesh setup. After they approve, ask the same question again to resume.`;
      return `${base} (${ids})`;
    }
    const base =
      result.message ??
      `${result.peer}'s agent is still inspecting. Continue with pairmesh_wait_for_inspection using that same requestId — do not start a new ask.`;
    return `${base} (${ids})`;
  }
  const body = formatInspectionCompletedText({
    peerName: result.peer,
    summary: result.summary ?? "",
    findings: result.findings,
    references: result.references
  });
  return `${body}\n\n(${ids})`;
}

function presentInspectionStatus(status: Record<string, unknown>): string {
  const peer =
    typeof status.peer === "string"
      ? status.peer
      : typeof status.peerName === "string"
        ? status.peerName
        : "Peer";
  const state = typeof status.status === "string" ? status.status : "unknown";

  if (state === "completed" && status.result && typeof status.result === "object") {
    const result = status.result as {
      summary?: string;
      findings?: string[];
      references?: Array<{
        file: string;
        symbol?: string;
        startLine?: number;
        endLine?: number;
      }>;
    };
    const body = formatInspectionCompletedText({
      peerName: peer,
      summary: result.summary ?? "Inspection completed.",
      findings: result.findings,
      references: result.references
    });
    const requestId = typeof status.requestId === "string" ? status.requestId : undefined;
    const threadId = typeof status.threadId === "string" ? status.threadId : undefined;
    if (requestId && threadId) {
      return `${body}\n\n(${presentInspectionIds({ requestId, threadId })})`;
    }
    return body;
  }

  if (state === "working" || state === "running" || state === "pending") {
    const requestId = typeof status.requestId === "string" ? status.requestId : undefined;
    const threadId = typeof status.threadId === "string" ? status.threadId : undefined;
    const base =
      (typeof status.message === "string" && status.message) ||
      (requestId
        ? `${peer} is still inspecting. The same remote task is running normally — call pairmesh_wait_for_inspection again with that requestId.`
        : `${peer} is still inspecting. The same remote task is running normally.`);
    if (requestId && threadId) {
      return `${base} (${presentInspectionIds({ requestId, threadId })})`;
    }
    if (requestId) {
      return `${base} (requestId ${requestId})`;
    }
    return base;
  }

  if (state === "timed_out") {
    return (
      (typeof status.message === "string" && status.message) ||
      "The remote inspection reached its hard deadline and timed out."
    );
  }

  if (state === "failed" || state === "cancelled") {
    return (typeof status.message === "string" && status.message) || `Inspection ${state}.`;
  }

  return typeof status.message === "string" ? status.message : `Inspection status: ${state}.`;
}

function presentWaitResult(result: {
  completed: boolean;
  requestId: string;
  threadId: string;
  status: string;
  result?: {
    summary: string;
    findings: string[];
    references?: Array<{
      file: string;
      symbol?: string;
      startLine?: number;
      endLine?: number;
    }>;
  };
  message?: string;
  peer?: string;
}): string {
  if (result.completed && result.result) {
    const body = formatInspectionCompletedText({
      peerName: result.peer ?? "Peer",
      summary: result.result.summary,
      findings: result.result.findings,
      references: result.result.references
    });
    return `${body}\n\n(${presentInspectionIds(result)})`;
  }

  if (result.status === "working" || result.status === "running" || result.status === "pending") {
    const base =
      result.message ??
      `${result.peer ?? "Peer"} is still inspecting. The same remote task is running normally — call pairmesh_wait_for_inspection again with that requestId.`;
    return `${base} (${presentInspectionIds(result)})`;
  }

  return result.message
    ? `${result.message} (${presentInspectionIds(result)})`
    : `Inspection ${result.status} (${presentInspectionIds(result)}).`;
}

function presentActionIds(result: { actionId: string; permissionRequestId?: string }): string {
  const parts = [`actionId ${result.actionId}`];
  if (result.permissionRequestId) {
    parts.push(`permissionRequestId ${result.permissionRequestId}`);
  }
  return parts.join("; ");
}

function presentActionWireText(result: {
  actionId: string;
  status: string;
  summary?: string;
  message?: string;
  permissionRequestId?: string;
}): string {
  if (result.status === "approval_required") {
    const base =
      result.message ??
      "Proposal ready — waiting for the peer to review and Approve Once in their local Inbox. Do not re-pair. There is no MCP approve tool.";
    return base;
  }
  if (result.summary) {
    return result.summary;
  }
  if (result.message) {
    return result.message;
  }
  return `Action ${result.status.replace(/_/g, " ")}.`;
}

function presentActionSafeText(result: {
  actionId: string;
  status: string;
  summary?: string;
  message?: string;
  permissionRequestId?: string;
  terminal?: boolean;
  timedOut?: boolean;
}): string {
  const ids = presentActionIds(result);
  if (result.timedOut) {
    const base =
      result.message ??
      `Action still ${result.status}. Call pairmesh_wait_for_action again with the same actionId — do not start a new action.`;
    return `${base} (${ids})`;
  }
  if (result.status === "approval_required") {
    const base =
      result.message ??
      "Peer must approve this action locally. Do not re-pair. There is no MCP approve tool — wait, then poll with the same actionId.";
    return `${base} (${ids})`;
  }
  if (result.summary) {
    return `${result.summary} (${ids}; status ${result.status})`;
  }
  if (result.message) {
    return `${result.message} (${ids}; status ${result.status})`;
  }
  return `Action ${result.status} (${ids}).`;
}

export function registerPairMeshTools(server: McpServer, sessionManager: SessionManager): void {
  server.registerTool(
    "pairmesh_status",
    {
      description:
        "Return whether a local PairMesh session is active, build metadata, and a short session summary.",
      inputSchema: z.object({})
    },
    async () =>
      runToolHandler(
        () => getPairMeshStatus(sessionManager),
        (status: PairMeshStatusResult) => {
          const build =
            status.pairmeshBuildId && status.pairmeshVersion
              ? ` PairMesh ${status.pairmeshVersion} build ${status.pairmeshBuildId}.`
              : status.pairmeshBuildId
                ? ` Build ${status.pairmeshBuildId}.`
                : "";
          const summary = status.connected
            ? `Connected to PairMesh session ${status.session?.code} (${status.peerCount ?? 0} peer(s)).${build}`
            : `Not connected to an active PairMesh session.${build}`;
          return toolSuccess(status, summary);
        }
      )
  );

  server.registerTool(
    "pairmesh_list_peers",
    {
      description: LIST_PEERS_DESCRIPTION,
      inputSchema: z.object({})
    },
    async () =>
      runToolHandler(
        () => listPairMeshPeers(sessionManager),
        (result: PairMeshListPeersResult) => {
          const summary =
            result.peers.length === 0
              ? "No peers configured in the active PairMesh session."
              : `Configured peers: ${result.peers
                  .map(
                    (peer: PairMeshListPeersResult["peers"][number]) =>
                      `${peer.displayName}${peer.service ? ` · ${peer.service}` : ""} [${peer.relationship}]`
                  )
                  .join(", ")}.`;
          return toolSuccess(result, summary);
        }
      )
  );

  server.registerTool(
    "pairmesh_ask",
    {
      description: ASK_NATURAL_DESCRIPTION,
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(120).describe(PEER_SELECTOR_DESCRIBE),
        request: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("Natural-language request for the peer (inspect or propose)"),
        intent: z
          .enum(["inspect", "propose", "goal"])
          .describe(
            "Required. inspect = read-only investigation. propose = change suggestion only (never auto-apply). goal = collaborative orchestration (owner still Approves Once)."
          ),
        waitMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Optional bounded wait for progress (ms)")
      })
    },
    async ({ peer, request, intent, waitMs }) =>
      runToolHandler(
        () => askPairMeshNatural(sessionManager, peer, request, intent, waitMs),
        (result) => {
          if (!result.ok) {
            if (result.code === "peer_ambiguous") {
              return toolSuccess(
                {
                  ambiguous: true,
                  matches: result.matches.map(
                    (match: { label: string; displayName: string; service?: string }) => ({
                      label: match.label,
                      displayName: match.displayName,
                      ...(match.service ? { service: match.service } : {})
                    })
                  ),
                  presentation: result.presentation
                },
                result.presentation
              );
            }
            return toolSuccess(
              { ok: false, code: result.code, presentation: result.presentation },
              result.presentation
            );
          }
          const payload =
            result.kind === "inspect"
              ? {
                  ok: true as const,
                  intent: result.intent,
                  peer: result.peer.label,
                  terminal: result.terminal,
                  kind: result.kind,
                  presentation: result.presentation,
                  autoApplied: false as const,
                  ...(result.requestId ? { requestId: result.requestId } : {}),
                  ...(result.threadId ? { threadId: result.threadId } : {})
                }
              : result.kind === "propose"
                ? {
                    ok: true as const,
                    intent: result.intent,
                    peer: result.peer.label,
                    terminal: result.terminal,
                    kind: result.kind,
                    presentation: result.presentation,
                    autoApplied: false as const,
                    status: result.action.status
                  }
                : {
                    ok: true as const,
                    intent: result.intent,
                    peer: result.peer.label,
                    terminal: result.terminal,
                    kind: result.kind,
                    presentation: result.presentation,
                    autoApplied: false as const,
                    taskId: result.taskId,
                    status: result.status,
                    ...(result.continuationSeq !== undefined
                      ? { continuationSeq: result.continuationSeq }
                      : {})
                  };
          return toolSuccess(payload, result.presentation);
        }
      )
  );

  server.registerTool(
    "pairmesh_send",
    {
      description:
        "Send a short message to a PairMesh peer in the active session (not for repository inspections).",
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE),
        message: z.string().trim().min(1).max(2000).describe("Message text to send via A2A")
      })
    },
    async ({ peer, message }) =>
      runToolHandler(
        () => sendPairMeshMessage(sessionManager, peer, message),
        (result: PairMeshSendResult) =>
          toolSuccess(result, `Peer ${result.peer} responded:\n${result.response}`)
      )
  );

  server.registerTool(
    "pairmesh_ask_peer",
    {
      description: ASK_PEER_DESCRIPTION,
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE),
        question: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("Read-only inspection question for the peer's local repository")
      })
    },
    async ({ peer, question }) =>
      runToolHandler(
        () => askPairMeshPeer(sessionManager, peer, question),
        (result: PairMeshAskPeerResult) => toolSuccess(result, presentAskOrFollowUp(result))
      )
  );

  server.registerTool(
    "pairmesh_follow_up",
    {
      description: FOLLOW_UP_DESCRIPTION,
      inputSchema: z.object({
        threadId: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe("Inspection thread id returned by pairmesh_ask_peer"),
        question: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("Follow-up read-only inspection question")
      })
    },
    async ({ threadId, question }) =>
      runToolHandler(
        () => followUpPairMeshInspection(sessionManager, threadId, question),
        (result: PairMeshFollowUpResult) => toolSuccess(result, presentAskOrFollowUp(result))
      )
  );

  server.registerTool(
    "pairmesh_list_threads",
    {
      description: "List inspection threads in the current PairMesh session.",
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(80).optional().describe(PEER_SELECTOR_DESCRIBE)
      })
    },
    async ({ peer }) =>
      runToolHandler(
        () => listPairMeshThreads(sessionManager, peer),
        (result: PairMeshListThreadsResult) =>
          toolSuccess(
            result,
            result.threads.length === 0
              ? "No inspection threads in the active session."
              : `Inspection threads: ${result.threads.map((thread) => `${thread.id} (${thread.peer}, ${thread.turnCount} turn(s))`).join("; ")}.`
          )
      )
  );

  server.registerTool(
    "pairmesh_get_thread",
    {
      description: "Return sanitized metadata and turns for one inspection thread.",
      inputSchema: z.object({
        threadId: z.string().trim().min(1).max(80).describe("Inspection thread id")
      })
    },
    async ({ threadId }) =>
      runToolHandler(
        () => getPairMeshThread(sessionManager, threadId),
        (thread) => toolSuccess(thread, `Thread ${thread.id} has ${thread.turns.length} turn(s).`)
      )
  );

  server.registerTool(
    "pairmesh_close_thread",
    {
      description: "Close an inspection thread and prevent further follow-ups.",
      inputSchema: z.object({
        threadId: z.string().trim().min(1).max(80).describe("Inspection thread id")
      })
    },
    async ({ threadId }) =>
      runToolHandler(
        () => closePairMeshThread(sessionManager, threadId),
        (result) => toolSuccess(result, `Inspection thread ${result.threadId} is closed.`)
      )
  );

  server.registerTool(
    "pairmesh_peer_health",
    {
      description:
        "Check whether a configured peer's PairMesh agent is reachable and ready for inspection.",
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE)
      })
    },
    async ({ peer }) =>
      runToolHandler(
        () => getPairMeshPeerHealth(sessionManager, peer),
        (health) => {
          if (!health.reachable) {
            return toolSuccess(
              health,
              `${peer}'s PairMesh agent is unreachable.${health.reason ? ` ${health.reason}` : ""}`
            );
          }
          const codingAgentStatus = health.codingAgent?.status;
          const coding =
            codingAgentStatus === undefined
              ? "coding agent status not disclosed"
              : codingAgentStatus === "available"
                ? "coding agent ready"
                : `coding agent ${codingAgentStatus}`;
          return toolSuccess(health, `${peer}'s PairMesh agent is reachable (${coding}).`);
        }
      )
  );

  server.registerTool(
    "pairmesh_inspection_status",
    {
      description: INSPECTION_STATUS_DESCRIPTION,
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(80).describe("Inspection request id")
      })
    },
    async ({ requestId }) =>
      runToolHandler(
        () => getPairMeshInspectionStatus(sessionManager, requestId),
        (status) => toolSuccess(status, presentInspectionStatus(status))
      )
  );

  server.registerTool(
    "pairmesh_wait_for_inspection",
    {
      description: WAIT_FOR_INSPECTION_DESCRIPTION,
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(80).describe("Inspection request id"),
        waitMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Optional wait duration in ms (clamped to MCP-safe maximum)")
      })
    },
    async ({ requestId, waitMs }) =>
      runToolHandler(
        () => waitForPairMeshInspection(sessionManager, requestId, waitMs),
        (result) => toolSuccess(result, presentWaitResult(result))
      )
  );

  server.registerTool(
    "pairmesh_cancel_inspection",
    {
      description: CANCEL_INSPECTION_DESCRIPTION,
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(80).describe("Inspection request id")
      })
    },
    async ({ requestId }) =>
      runToolHandler(
        () => cancelPairMeshInspection(sessionManager, requestId),
        (result) =>
          toolSuccess(
            result,
            result.cancelled
              ? `Cancellation requested for inspection ${result.requestId}.`
              : `Inspection ${result.requestId} was not in flight locally.`
          )
      )
  );

  server.registerTool(
    "pairmesh_propose_change",
    {
      description: PROPOSE_CHANGE_DESCRIPTION,
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE),
        instruction: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("Natural-language change instruction for the peer's proposal-only path")
      })
    },
    async ({ peer, instruction }) =>
      runToolHandler(
        () => proposePairMeshChange(sessionManager, peer, instruction),
        (result) => toolSuccess(result, presentActionWireText(result))
      )
  );

  server.registerTool(
    "pairmesh_request_apply",
    {
      description: REQUEST_APPLY_DESCRIPTION,
      inputSchema: z.object({
        peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE),
        artifactId: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe("Proposal artifact id (art_…) from a prior change.propose"),
        contentHash: z
          .string()
          .trim()
          .regex(/^[a-fA-F0-9]{64}$/)
          .describe("Exact sha256 content hash of the proposal artifact")
      })
    },
    async ({ peer, artifactId, contentHash }) =>
      runToolHandler(
        () => requestPairMeshApply(sessionManager, peer, artifactId, contentHash),
        (result) => toolSuccess(result, presentActionWireText(result))
      )
  );

  server.registerTool(
    "pairmesh_run_tests",
    {
      description: RUN_TESTS_DESCRIPTION,
      inputSchema: z
        .object({
          peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE),
          profile: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .describe("Receiver-owned test profile name only (no executable/args/cwd/env)")
        })
        .strict()
    },
    async (args) =>
      runToolHandler(
        () =>
          runPairMeshTests(
            sessionManager,
            args.peer,
            args.profile,
            args as Record<string, unknown>
          ),
        (result) => toolSuccess(result, presentActionWireText(result))
      )
  );

  server.registerTool(
    "pairmesh_execute_process",
    {
      description: EXECUTE_PROCESS_DESCRIPTION,
      inputSchema: z
        .object({
          peer: z.string().trim().min(1).max(80).describe(PEER_SELECTOR_DESCRIBE),
          executable: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .describe("Executable basename only (e.g. npm). No paths."),
          args: z
            .array(z.string().max(500))
            .max(50)
            .default([])
            .describe("Argument list (literal strings; not a shell command)"),
          cwd: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .optional()
            .describe("Optional workspace-relative working directory"),
          timeoutMs: z
            .number()
            .int()
            .min(1_000)
            .max(600_000)
            .optional()
            .describe("Optional timeout in milliseconds")
        })
        .strict()
    },
    async (args) =>
      runToolHandler(
        () =>
          executePairMeshProcess(
            sessionManager,
            args.peer,
            args.executable,
            args.args ?? [],
            { cwd: args.cwd, timeoutMs: args.timeoutMs },
            args as Record<string, unknown>
          ),
        (result) => toolSuccess(result, presentActionWireText(result))
      )
  );

  server.registerTool(
    "pairmesh_action_status",
    {
      description: ACTION_STATUS_DESCRIPTION,
      inputSchema: z.object({
        actionId: z.string().trim().min(1).max(80).describe("Controlled-action id (act_…)")
      })
    },
    async ({ actionId }) =>
      runToolHandler(
        () => getPairMeshActionStatus(sessionManager, actionId),
        (result) => toolSuccess(result, presentActionSafeText(result))
      )
  );

  server.registerTool(
    "pairmesh_wait_for_action",
    {
      description: WAIT_FOR_ACTION_DESCRIPTION,
      inputSchema: z.object({
        actionId: z.string().trim().min(1).max(80).describe("Controlled-action id (act_…)"),
        waitMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Optional wait duration in ms (clamped to MCP-safe maximum)")
      })
    },
    async ({ actionId, waitMs }) =>
      runToolHandler(
        () => waitForPairMeshAction(sessionManager, actionId, waitMs),
        (result) =>
          toolSuccess(
            result,
            presentActionSafeText({ ...result.action, timedOut: result.timedOut })
          )
      )
  );

  server.registerTool(
    "pairmesh_cancel_action",
    {
      description: CANCEL_ACTION_DESCRIPTION,
      inputSchema: z.object({
        actionId: z.string().trim().min(1).max(80).describe("Controlled-action id (act_…)")
      })
    },
    async ({ actionId }) =>
      runToolHandler(
        () => cancelPairMeshAction(sessionManager, actionId),
        (result) =>
          toolSuccess(
            result,
            result.status === "cancelled"
              ? `Cancellation recorded for action ${result.actionId}.`
              : presentActionSafeText(result)
          )
      )
  );
}

export function createPairMeshMcpServer(
  sessionManager: SessionManager,
  options?: { role?: "requester" | "receiver"; workspace?: string }
): McpServer {
  const server = new McpServer({
    name: PAIRMESH_MCP_SERVER_NAME,
    version: PAIRMESH_MCP_SERVER_VERSION
  });

  const role = options?.role ?? resolveMcpRoleFromEnv();
  if (role === "receiver") {
    registerReceiverPairMeshTools(server, sessionManager, { workspace: options?.workspace });
  } else {
    registerPairMeshTools(server, sessionManager);
  }
  return server;
}

export function resolveMcpRoleFromEnv(): "requester" | "receiver" {
  const raw = (process.env.PAIRMESH_MCP_ROLE ?? "requester").trim().toLowerCase();
  return raw === "receiver" ? "receiver" : "requester";
}
