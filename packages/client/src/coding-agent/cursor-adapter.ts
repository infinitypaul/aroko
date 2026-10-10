import type { InspectionProgressEvent } from "@pairmesh/protocol";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { AcpJsonRpcClient, assertCommandAvailable } from "./acp-client.js";
import { probeCodingAgentAvailability } from "./availability.js";
import { CursorAcpActivitySession } from "./cursor-acp-activity.js";
import {
  buildFollowUpContinuationPrompt,
  buildFollowUpInspectionPrompt,
  buildInspectionPrompt,
  buildProposalPrompt
} from "./prompt.js";
import {
  parseProviderProposalResponse,
  providerProposalToUnifiedDiff
} from "./proposal-provider-response.js";
import { parseInspectionAgentOutput, validateReferencesInWorkspace } from "./source-references.js";
import { sanitizeFindings, sanitizeInspectionOutput } from "./sanitize.js";
import { CURSOR_PROVIDER } from "./descriptors.js";
import {
  createCodingAgentError,
  resolveProviderSessionId,
  type CodingAgentAdapter,
  type CodingAgentAdapterOptions,
  type CodingAgentAvailability,
  type CodingAgentInspectOptions,
  type CodingAgentProposeOptions,
  type CodingAgentProposeRequest,
  type CodingAgentProposeResult,
  type CodingAgentProviderDescriptor,
  type CodingAgentRequest,
  type CodingAgentResult
} from "./types.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";

const WRITE_PERMISSION_HINTS = ["write", "edit", "delete", "commit", "push", "shell", "terminal"];

/** Minimal ACP client surface used by CursorAcpAdapter (real or test double). */
export interface CursorAcpClient {
  onNotification(method: string, handler: (params: unknown) => void | Promise<void>): void;
  onRequest(
    method: string,
    handler: (params: unknown, id: number) => unknown | Promise<unknown>
  ): void;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface CursorAcpAdapterOptions extends CodingAgentAdapterOptions {
  /** Test seam — defaults to spawning real `agent acp`. */
  createAcpClient?: (input: { command: string; args: string[]; cwd: string }) => CursorAcpClient;
}

export class CursorAcpAdapter implements CodingAgentAdapter {
  public readonly provider: CodingAgentProviderDescriptor = CURSOR_PROVIDER;
  private readonly options: CursorAcpAdapterOptions;
  private activeRequestId: string | undefined;
  private activeCancel: (() => Promise<void>) | undefined;

  public constructor(options: CursorAcpAdapterOptions) {
    this.options = options;
  }

  public async getAvailability(): Promise<CodingAgentAvailability> {
    // Test seam: createAcpClient injects a fake ACP client — skip real `agent` PATH probe (CI).
    if (this.options.createAcpClient) {
      if (this.activeRequestId) {
        return {
          provider: "cursor",
          configured: true,
          status: "busy",
          reason: "A coding-agent inspection is already in progress."
        };
      }
      const workspace = this.options.workspace?.trim();
      if (!workspace) {
        return {
          provider: "cursor",
          configured: false,
          status: "unavailable",
          reason: "Workspace is not configured."
        };
      }
      try {
        await access(resolve(workspace));
      } catch {
        return {
          provider: "cursor",
          configured: false,
          status: "unavailable",
          reason: "Configured workspace does not exist."
        };
      }
      return { provider: "cursor", configured: true, status: "available" };
    }

    return await probeCodingAgentAvailability({
      provider: "cursor",
      workspace: this.options.workspace,
      command: this.options.command,
      busy: this.activeRequestId !== undefined
    });
  }

  public async inspect(
    request: CodingAgentRequest,
    options?: CodingAgentInspectOptions
  ): Promise<CodingAgentResult> {
    if (this.activeRequestId) {
      throw createCodingAgentError(
        "agent_busy",
        "Cursor coding agent is busy with another inspection."
      );
    }

    this.activeRequestId = request.requestId;
    const startedAt = Date.now();
    let elapsedTimer: NodeJS.Timeout | undefined;
    let richActivitySeen = false;

    const emitProgress = (event: InspectionProgressEvent): void => {
      // Once rich ACP activity is flowing, suppress coarse Investigating noise.
      if (richActivitySeen && event.phase === "inspecting") {
        return;
      }
      options?.onProgress?.(event);
    };

    const emitActivity = (event: ProviderActivityEvent): void => {
      richActivitySeen = true;
      options?.onProviderActivity?.(event);
    };

    emitProgress({
      phase: "coding-agent-starting",
      message: "Starting coding agent inspection.",
      elapsedMs: 0
    });

    elapsedTimer = setInterval(() => {
      emitProgress({
        phase: "inspecting",
        message: "Coding agent is inspecting the repository.",
        elapsedMs: Date.now() - startedAt
      });
    }, 5_000);

    try {
      return await withTimeout(
        this.runInspection(request, emitProgress, emitActivity, options?.signal),
        this.options.timeoutMs,
        options?.signal
      );
    } finally {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
      }
      this.activeRequestId = undefined;
      this.activeCancel = undefined;
    }
  }

  public async cancelActiveInspection(): Promise<boolean> {
    if (!this.activeRequestId || !this.activeCancel) {
      return false;
    }
    await this.activeCancel();
    return true;
  }

    public async proposeChange(
    request: CodingAgentProposeRequest,
    options?: CodingAgentProposeOptions
  ): Promise<CodingAgentProposeResult> {
    if (this.activeRequestId) {
      throw createCodingAgentError(
        "agent_busy",
        "Cursor coding agent is busy with another request."
      );
    }

    this.activeRequestId = request.requestId;
    const emit = options?.onProviderActivity;
    try {
      return await withTimeout(
        this.runProposal(request, emit, options?.signal),
        this.options.timeoutMs,
        options?.signal
      );
    } finally {
      this.activeRequestId = undefined;
      this.activeCancel = undefined;
    }
  }

  private async runProposal(
    request: CodingAgentProposeRequest,
    emit: ((event: ProviderActivityEvent) => void) | undefined,
    signal?: AbortSignal
  ): Promise<CodingAgentProposeResult> {
    const command = this.options.command ?? "agent";
    if (!this.options.createAcpClient) {
      await assertCommandAvailable(command);
    }

    const client =
      this.options.createAcpClient?.({
        command,
        args: this.options.args ?? ["acp"],
        cwd: this.options.workspace
      }) ?? new AcpJsonRpcClient(command, this.options.args ?? ["acp"], this.options.workspace);

    let cancelled = false;
    let permissionDenied = false;
    let sessionId: string | undefined;
    const chunks: string[] = [];

    this.activeCancel = async () => {
      cancelled = true;
      if (sessionId) {
        try {
          await client.request("session/cancel", { sessionId });
        } catch {
          // ignore
        }
      }
    };

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          void this.activeCancel?.();
        },
        { once: true }
      );
    }

    const activity = new CursorAcpActivitySession({
      workspace: this.options.workspace,
      requestId: request.requestId,
      onActivity: emit
    });

    client.onNotification("session/update", (params) => {
      if (cancelled || activity.isFenced) {
        return;
      }
      const messageText = extractMessageTextForFinalAnswer(params);
      if (messageText !== undefined) {
        chunks.push(messageText);
      }
      activity.handleSessionUpdate(params);
    });

    client.onRequest("session/request_permission", (params) => {
      const optionIds = extractPermissionOptionIds(params);
      const title = extractPermissionTitle(params);
      if (isWriteLikePermission(title, optionIds)) {
        permissionDenied = true;
        return { outcome: { outcome: "selected", optionId: "reject-once" } };
      }
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });

    client.onRequest("cursor/ask_question", () => ({
      outcome: { outcome: "skipped", reason: "PairMesh proposal runs unattended." }
    }));

    client.onRequest("cursor/create_plan", () => ({
      outcome: { outcome: "rejected", reason: "PairMesh proposal generation is read-only." }
    }));

    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: false
        },
        clientInfo: { name: "pairmesh-acp-client", version: "0.3.0" }
      });

      try {
        await client.request("authenticate", { methodId: "cursor_login" });
      } catch (error) {
        throw createCodingAgentError(
          "agent_not_authenticated",
          "Cursor CLI is not authenticated. Run `agent login` first.",
          { reason: error instanceof Error ? error.message : String(error) }
        );
      }

      if (cancelled) {
        throw createCodingAgentError("agent_cancelled", "Proposal generation was cancelled.");
      }

      emit?.({
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Cursor worker started.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:worker.started`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });

      emit?.({
        phase: "proposal_preparing",
        activityKind: "proposal.preparing",
        message: "Preparing change proposal (ACP read-only).",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:proposal.preparing`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });

      const sessionResult = (await client.request("session/new", {
        cwd: this.options.workspace,
        mode: this.options.mode,
        mcpServers: []
      })) as { sessionId?: string };

      sessionId = sessionResult.sessionId;
      if (!sessionId) {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Cursor ACP did not return a session id."
        );
      }

      const prompt = buildProposalPrompt(request.instruction);
      const promptResult = (await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }]
      })) as { stopReason?: string };

      activity.flushMessages();

      if (cancelled) {
        throw createCodingAgentError("agent_cancelled", "Proposal generation was cancelled.");
      }

      if (permissionDenied) {
        throw createCodingAgentError(
          "agent_permission_denied",
          "Cursor requested a write or destructive permission during proposal-only generation."
        );
      }

      const combined = chunks.join("").trim();
      if (!combined && promptResult.stopReason !== "end_turn") {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Cursor ACP returned no proposal output.",
          { stopReason: promptResult.stopReason }
        );
      }

      const providerProposal = parseProviderProposalResponse(combined);
      const unifiedDiff = providerProposalToUnifiedDiff(providerProposal);
      const result: CodingAgentProposeResult = {
        summary: sanitizeInspectionOutput(providerProposal.summary, {
          workspace: this.options.workspace
        }),
        unifiedDiff,
        providerMetadata: {
          mode: "proposal_only",
          mutatedWorkingTree: false,
          acpFsReadTextFile: true,
          acpFsWriteTextFile: false,
          acpTerminal: false,
          provider: "cursor"
        }
      };

      emit?.({
        phase: "proposal_ready",
        activityKind: "proposal.ready",
        message: "Proposal ready.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:proposal.ready`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });
      emit?.({
        phase: "completed",
        activityKind: "worker.completed",
        message: "Cursor worker finished.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:worker.completed`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });

      return result;
    } catch (error) {
      activity.fence();
      emit?.({
        phase: "failed",
        activityKind: "worker.failed",
        message: "Cursor worker failed.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:worker.failed`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });
      if (sessionId && !cancelled) {
        try {
          await client.request("session/cancel", { sessionId });
        } catch {
          // ignore
        }
      }
      throw error;
    } finally {
      activity.fence();
      activity.clear();
      await client.close();
    }
  }

  private async runInspection(
    request: CodingAgentRequest,
    emitProgress: (event: InspectionProgressEvent) => void,
    emitActivity: (event: ProviderActivityEvent) => void,
    signal?: AbortSignal
  ): Promise<CodingAgentResult> {
    const command = this.options.command ?? "agent";
    if (!this.options.createAcpClient) {
      await assertCommandAvailable(command);
    }

    const client =
      this.options.createAcpClient?.({
        command,
        args: this.options.args ?? ["acp"],
        cwd: this.options.workspace
      }) ?? new AcpJsonRpcClient(command, this.options.args ?? ["acp"], this.options.workspace);

    const chunks: string[] = [];
    let sessionId: string | undefined;
    let permissionDenied = false;
    let continuityMode: CodingAgentResult["continuityMode"] = "native_provider_session";
    let usedNativeResume = false;
    let cancelled = false;

    const activity = new CursorAcpActivitySession({
      workspace: this.options.workspace,
      requestId: request.requestId,
      onActivity: emitActivity
    });

    const cancel = async (): Promise<void> => {
      cancelled = true;
      activity.fence();
      if (sessionId) {
        try {
          await client.request("session/cancel", { sessionId });
        } catch {
          // ignore cancel failures
        }
      }
      await client.close();
    };

    this.activeCancel = cancel;

    if (signal) {
      if (signal.aborted) {
        await cancel();
        throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
      }
      signal.addEventListener(
        "abort",
        () => {
          void cancel();
        },
        { once: true }
      );
    }

    client.onNotification("session/update", (params) => {
      if (cancelled || activity.isFenced) {
        return;
      }

      // Final-answer accumulation (unchanged semantics) — thought chunks never join here.
      const messageText = extractMessageTextForFinalAnswer(params);
      if (messageText !== undefined) {
        chunks.push(messageText);
      }

      // Rich live mapping (tools + aggregated provider.message).
      activity.handleSessionUpdate(params);
    });

    client.onRequest("session/request_permission", (params) => {
      const optionIds = extractPermissionOptionIds(params);
      const title = extractPermissionTitle(params);
      if (isWriteLikePermission(title, optionIds)) {
        permissionDenied = true;
        return { outcome: { outcome: "selected", optionId: "reject-once" } };
      }
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });

    client.onRequest("cursor/ask_question", () => ({
      outcome: { outcome: "skipped", reason: "PairMesh inspection runs unattended." }
    }));

    client.onRequest("cursor/create_plan", () => ({
      outcome: { outcome: "rejected", reason: "PairMesh inspection is read-only." }
    }));

    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: false
        },
        clientInfo: { name: "pairmesh-acp-client", version: "0.3.0" }
      });

      try {
        await client.request("authenticate", { methodId: "cursor_login" });
      } catch (error) {
        throw createCodingAgentError(
          "agent_not_authenticated",
          "Cursor CLI is not authenticated. Run `agent login` first.",
          { reason: error instanceof Error ? error.message : String(error) }
        );
      }

      if (cancelled) {
        throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
      }

      emitActivity({
        phase: "provider_started",
        activityKind: "worker.started",
        message: "Cursor worker started.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:worker.started`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });

      emitProgress({
        phase: "inspecting",
        message: "Coding agent session ready."
      });

      const existingProviderSessionId = resolveProviderSessionId(request.continuation);
      if (existingProviderSessionId) {
        try {
          await client.request("session/load", { sessionId: existingProviderSessionId });
          sessionId = existingProviderSessionId;
          usedNativeResume = true;
        } catch {
          continuityMode = "sanitized_history_fallback";
        }
      }

      if (!sessionId) {
        const sessionResult = (await client.request("session/new", {
          cwd: this.options.workspace,
          mode: this.options.mode,
          mcpServers: []
        })) as { sessionId?: string };

        sessionId = sessionResult.sessionId;
        if (!sessionId) {
          throw createCodingAgentError(
            "agent_execution_failed",
            "Cursor ACP did not return a session id."
          );
        }
      }

      const prompt = buildPromptForRequest(request, usedNativeResume, continuityMode);
      const promptResult = (await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }]
      })) as { stopReason?: string };

      // End-of-turn: flush aggregated narration once (still before terminal fence).
      activity.flushMessages();

      if (cancelled) {
        throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
      }

      if (permissionDenied) {
        throw createCodingAgentError(
          "agent_permission_denied",
          "Cursor requested a write or destructive permission during read-only inspection."
        );
      }

      const combined = chunks.join("").trim();
      if (!combined && promptResult.stopReason !== "end_turn") {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Cursor ACP returned no inspection output.",
          { stopReason: promptResult.stopReason }
        );
      }

      const parsed = parseInspectionAgentOutput(combined, { workspace: this.options.workspace });
      const summary = sanitizeInspectionOutput(parsed.summary, {
        workspace: this.options.workspace
      });
      const findings = sanitizeFindings(parsed.findings, { workspace: this.options.workspace });
      const references = await validateReferencesInWorkspace(
        parsed.references,
        this.options.workspace
      );

      emitActivity({
        phase: "completed",
        activityKind: "worker.completed",
        message: "Cursor worker finished.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:cursor:worker.completed`,
        safeMetadata: { provider: "cursor", correlationId: request.requestId }
      });

      emitProgress({
        phase: "completed",
        message: "Inspection completed."
      });

      return {
        summary,
        findings,
        references,
        providerSessionId: sessionId,
        continuityMode
      };
    } catch (error) {
      activity.fence();
      if (sessionId && !cancelled) {
        try {
          await client.request("session/cancel", { sessionId });
        } catch {
          // ignore cancel failures
        }
      }
      throw error;
    } finally {
      activity.fence();
      activity.clear();
      await client.close();
    }
  }
}

function extractMessageTextForFinalAnswer(params: unknown): string | undefined {
  const root =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined;
  const update =
    (root?.update && typeof root.update === "object" && !Array.isArray(root.update)
      ? (root.update as Record<string, unknown>)
      : root) ?? undefined;
  if (!update || update.sessionUpdate !== "agent_message_chunk") {
    return undefined;
  }
  const content =
    update.content && typeof update.content === "object" && !Array.isArray(update.content)
      ? (update.content as Record<string, unknown>)
      : undefined;
  return typeof content?.text === "string" && content.text.length > 0 ? content.text : undefined;
}

function buildPromptForRequest(
  request: CodingAgentRequest,
  usedNativeResume: boolean,
  continuityMode: CodingAgentResult["continuityMode"]
): string {
  if (usedNativeResume && (request.turnNumber ?? 1) > 1) {
    return buildFollowUpContinuationPrompt(request.question);
  }

  const priorTurns = request.continuation?.priorTurns ?? [];
  if (continuityMode === "sanitized_history_fallback" && priorTurns.length > 0) {
    return buildFollowUpInspectionPrompt(request.question, priorTurns);
  }

  return buildInspectionPrompt(request.question);
}

function extractPermissionOptionIds(params: unknown): string[] {
  const options = (params as { options?: Array<{ optionId?: string }> })?.options ?? [];
  return options.map((option) => option.optionId ?? "").filter(Boolean);
}

function extractPermissionTitle(params: unknown): string {
  return String((params as { toolCall?: { title?: string } })?.toolCall?.title ?? "").toLowerCase();
}

function isWriteLikePermission(title: string, optionIds: string[]): boolean {
  const haystack = `${title} ${optionIds.join(" ")}`.toLowerCase();
  return WRITE_PERMISSION_HINTS.some((hint) => haystack.includes(hint));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        createCodingAgentError("agent_timeout", "Coding agent inspection timed out.", {
          timeoutMs,
          phase: "inspecting"
        })
      );
    }, timeoutMs);
  });

  const abortPromise =
    signal &&
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
        },
        { once: true }
      );
    });

  try {
    return await Promise.race([promise, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
