import { type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { InspectionProgressEvent } from "@pairmesh/protocol";
import { assertCommandAvailable } from "./acp-client.js";
import {
  ClaudeStreamSession,
  dedupeClaudeActivityEvents,
  parseClaudeStreamJson
} from "./claude-stream-activity.js";
import { CLAUDE_CODE_PROVIDER } from "./descriptors.js";
import {
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
import { runStreamingProcess } from "./streaming-process.js";
import {
  createCodingAgentError,
  type CodingAgentAdapter,
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

export interface ClaudeCodeAdapterOptions {
  workspace: string;
  timeoutMs: number;
  command?: string;
  /** Extra args inserted after the command name (before PairMesh defaults). */
  args?: string[];
  /** Test seam — defaults to spawning the real Claude Code CLI. */
  runProcess?: ClaudeCodeProcessRunner;
}

export interface ClaudeCodeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ClaudeCodeProcessRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onSpawn?: (child: ChildProcess) => void;
    onStdoutChunk?: (chunk: string) => void;
}) => Promise<ClaudeCodeProcessResult>;

export class ClaudeCodeAdapter implements CodingAgentAdapter {
  public readonly provider: CodingAgentProviderDescriptor = CLAUDE_CODE_PROVIDER;
  private readonly options: ClaudeCodeAdapterOptions;
  private activeRequestId: string | undefined;
  private activeChild: ChildProcess | undefined;

  public constructor(options: ClaudeCodeAdapterOptions) {
    this.options = options;
  }

  public async getAvailability(): Promise<CodingAgentAvailability> {
    if (this.activeRequestId) {
      return {
        provider: "claude-code",
        configured: true,
        status: "busy",
        reason: "A coding-agent inspection is already in progress."
      };
    }

    const workspace = this.options.workspace?.trim();
    if (!workspace) {
      return {
        provider: "claude-code",
        configured: false,
        status: "unavailable",
        reason: "PAIRMESH_WORKSPACE is not configured."
      };
    }

    try {
      await access(resolve(workspace));
    } catch {
      return {
        provider: "claude-code",
        configured: false,
        status: "unavailable",
        reason: "Configured workspace does not exist."
      };
    }

    const command = this.options.command ?? "claude";
    // Test seam: runProcess injects a fake CLI — do not require a real binary on PATH (CI).
    if (!this.options.runProcess) {
      try {
        await assertCommandAvailable(command);
      } catch (error) {
        return {
          provider: "claude-code",
          configured: true,
          status: "unavailable",
          reason:
            error instanceof Error
              ? error.message
              : "Claude Code CLI is not installed or not on PATH."
        };
      }
    }

    return {
      provider: "claude-code",
      configured: true,
      status: "available"
    };
  }

  public async inspect(
    request: CodingAgentRequest,
    options?: CodingAgentInspectOptions
  ): Promise<CodingAgentResult> {
    if (this.activeRequestId) {
      throw createCodingAgentError(
        "agent_busy",
        "Claude Code coding agent is busy with another inspection."
      );
    }

    this.activeRequestId = request.requestId;
    const startedAt = Date.now();
    let elapsedTimer: NodeJS.Timeout | undefined;
    let richActivitySeen = false;

    const emitProgress = (event: InspectionProgressEvent): void => {
      if (richActivitySeen && event.phase === "inspecting") {
        return;
      }
      options?.onProgress?.(event);
    };

    const wrapActivity = (event: ProviderActivityEvent): void => {
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
      return await this.runInspection(request, emitProgress, {
        ...options,
        onProviderActivity: wrapActivity
      });
    } finally {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
      }
      this.activeRequestId = undefined;
      this.activeChild = undefined;
    }
  }

  public async proposeChange(
    request: CodingAgentProposeRequest,
    options?: CodingAgentProposeOptions
  ): Promise<CodingAgentProposeResult> {
    if (this.activeRequestId) {
      throw createCodingAgentError(
        "agent_busy",
        "Claude Code coding agent is busy with another request."
      );
    }

    this.activeRequestId = request.requestId;
    const emit = options?.onProviderActivity;
    try {
      if (options?.signal?.aborted) {
        throw createCodingAgentError("agent_cancelled", "Proposal generation was cancelled.");
      }

      const stream = await this.runReadOnlyStream({
        prompt: buildProposalPrompt(request.instruction),
        signal: options?.signal,
        timeoutMessage: "Coding agent proposal generation timed out.",
        requestId: request.requestId,
        onActivity: emit
      });

      if (options?.signal?.aborted) {
        throw createCodingAgentError("agent_cancelled", "Proposal generation was cancelled.");
      }

      if (!stream.emittedWorkerStarted) {
        emit?.({
          phase: "provider_started",
          activityKind: "worker.started",
          message: "Starting isolated headless Claude worker.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:pairmesh:worker.started`,
          safeMetadata: { provider: "claude-code", correlationId: request.requestId }
        });
      }

      emit?.({
        phase: "proposal_preparing",
        activityKind: "proposal.preparing",
        message: "Preparing change proposal (read-only tools).",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:pairmesh:proposal.preparing`,
        safeMetadata: { provider: "claude-code", correlationId: request.requestId }
      });

      const providerProposal = parseProviderProposalResponse(stream.responseText);
      const unifiedDiff = providerProposalToUnifiedDiff(providerProposal);
      const result: CodingAgentProposeResult = {
        summary: sanitizeInspectionOutput(providerProposal.summary, {
          workspace: this.options.workspace
        }),
        unifiedDiff,
        providerMetadata: {
          mode: "proposal_only",
          mutatedWorkingTree: false,
          allowedTools: "Read,Grep,Glob",
          permissionMode: "dontAsk",
          outputFormat: "stream-json",
          richToolActivity: stream.hasRichToolActivity
        }
      };

      emit?.({
        phase: "proposal_ready",
        activityKind: "proposal.ready",
        message: "Proposal ready.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:pairmesh:proposal.ready`,
        safeMetadata: { provider: "claude-code", correlationId: request.requestId }
      });
      emit?.({
        phase: "completed",
        activityKind: "worker.completed",
        message: "Claude worker completed.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:pairmesh:worker.completed`,
        safeMetadata: { provider: "claude-code", correlationId: request.requestId }
      });

      return result;
    } catch (error) {
      emit?.({
        phase: "failed",
        activityKind: "worker.failed",
        message: "Claude worker failed.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:pairmesh:worker.failed`,
        safeMetadata: { provider: "claude-code", correlationId: request.requestId }
      });
      throw error;
    } finally {
      this.activeRequestId = undefined;
      this.activeChild = undefined;
    }
  }

  public async cancelActiveInspection(): Promise<boolean> {
    if (!this.activeChild) {
      return false;
    }
    this.activeChild.kill("SIGTERM");
    return true;
  }

  private async runInspection(
    request: CodingAgentRequest,
    emitProgress: (event: InspectionProgressEvent) => void,
    options?: CodingAgentInspectOptions
  ): Promise<CodingAgentResult> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
    }

    const stream = await this.runReadOnlyStream({
      prompt: buildPromptForRequest(request),
      signal,
      timeoutMessage: "Coding agent inspection timed out.",
      requestId: request.requestId,
      onActivity: options?.onProviderActivity
    });

    emitProgress({
      phase: "inspecting",
      message: "Coding agent is inspecting the repository.",
      elapsedMs: 0
    });

    if (signal?.aborted) {
      throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
    }

    const parsed = parseInspectionAgentOutput(stream.responseText);
    const summary = sanitizeInspectionOutput(parsed.summary || stream.responseText, {
      workspace: this.options.workspace
    });
    const findings = sanitizeFindings(parsed.findings.length > 0 ? parsed.findings : [summary], {
      workspace: this.options.workspace
    });
    const references = await validateReferencesInWorkspace(
      parsed.references,
      this.options.workspace
    );

    emitProgress({
      phase: "completed",
      message: "Inspection completed.",
      elapsedMs: 0
    });

    return {
      summary,
      findings,
      references,
      continuityMode: "sanitized_history_fallback"
    };
  }

  /**
   * Shared headless Claude invocation with stream-json + read-only tool allowlist.
   * Write/Edit/Bash are never included for PairMesh inspect/propose paths.
   */
  private async runReadOnlyStream(input: {
    prompt: string;
    signal?: AbortSignal;
    timeoutMessage: string;
    requestId: string;
    onActivity?: (event: ProviderActivityEvent) => void;
  }): Promise<{
    responseText: string;
    hasRichToolActivity: boolean;
    emittedWorkerStarted: boolean;
  }> {
    const command = this.options.command ?? "claude";
    if (!this.options.runProcess) {
      await assertCommandAvailable(command);
    }

    const args = [
      ...(this.options.args ?? []),
      "--print",
      input.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Grep,Glob"
    ];

    const runner = this.options.runProcess ?? defaultClaudeCodeProcessRunner;
    const session = new ClaudeStreamSession({
      workspace: this.options.workspace,
      requestId: input.requestId,
      onActivity: input.onActivity
    });
    const onAbortFence = (): void => {
      session.fence();
    };
    if (input.signal) {
      if (input.signal.aborted) {
        session.fence();
      } else {
        input.signal.addEventListener("abort", onAbortFence, { once: true });
      }
    }

    let result: ClaudeCodeProcessResult;
    try {
      result = await runner({
        command,
        args,
        cwd: this.options.workspace,
        signal: input.signal,
        timeoutMs: this.options.timeoutMs,
        onSpawn: (child) => {
          this.activeChild = child;
        },
        onStdoutChunk: (chunk) => {
          session.pushStdout(chunk);
        }
      });
    } catch (error) {
      session.fence();
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbortFence);
      }
      if (isCodingAgentErrorLike(error)) {
        throw error;
      }
      throw createCodingAgentError(
        "agent_execution_failed",
        error instanceof Error ? error.message : "Claude Code invocation failed."
      );
    } finally {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbortFence);
      }
    }

    // Process exited — finalize result. Fence only after consume/finalize so buffered
    // test runners and trailing fragments can still be ingested once.
    try {
      return mapClaudeCodeStreamResult(result, {
        workspace: this.options.workspace,
        requestId: input.requestId,
        onActivity: input.onActivity,
        timeoutMessage: input.timeoutMessage,
        session
      });
    } finally {
      session.fence();
    }
  }
}

function buildPromptForRequest(request: CodingAgentRequest): string {
  const priorTurns = request.continuation?.priorTurns ?? [];
  if (priorTurns.length > 0 && (request.turnNumber ?? 1) > 1) {
    return buildFollowUpInspectionPrompt(request.question, priorTurns);
  }
  return buildInspectionPrompt(request.question);
}

export function mapClaudeCodeStreamResult(
  result: ClaudeCodeProcessResult,
  context: {
    workspace: string;
    requestId: string;
    onActivity?: (event: ProviderActivityEvent) => void;
    timeoutMessage?: string;
    /** When provided, activity was (or will be) emitted by the session — no post-exit burst. */
    session?: ClaudeStreamSession;
  }
): { responseText: string; hasRichToolActivity: boolean; emittedWorkerStarted: boolean } {
  let parsed;
  if (context.session) {
    if (context.session.didEmitLiveActivity || context.session.receivedLiveChunks) {
      // Live path: flush trailing fragment; activity already emitted (or fenced).
      parsed = context.session.finalize({ emitTrailingFragment: true });
      // If a runner streamed activity but omitted the final result line from chunks,
      // recover response text from captured stdout without re-emitting activity.
      if (!parsed.responseText.trim() && result.stdout.trim()) {
        const fallback = parseClaudeStreamJson({
          stdout: result.stdout,
          workspace: context.workspace,
          requestId: context.requestId
        });
        parsed = {
          ...parsed,
          responseText: fallback.responseText,
          isError: parsed.isError || fallback.isError,
          errorMessage: parsed.errorMessage ?? fallback.errorMessage,
          sessionId: parsed.sessionId ?? fallback.sessionId
        };
      }
    } else {
      // Buffered test runner: single-shot ingest + emit once.
      parsed = context.session.consumeBufferedStdout(result.stdout);
    }
  } else {
    parsed = parseClaudeStreamJson({
      stdout: result.stdout,
      workspace: context.workspace,
      requestId: context.requestId
    });
    const activity = dedupeClaudeActivityEvents(parsed.activity);
    for (const event of activity) {
      context.onActivity?.(event);
    }
  }

  let emittedWorkerStarted = false;
  for (const event of parsed.activity) {
    if (event.activityKind === "worker.started") {
      emittedWorkerStarted = true;
    }
  }

  if (parsed.isError) {
    const message = parsed.errorMessage ?? "Claude Code reported an error.";
    if (/auth|login|credential|api.?key|not.?authenticated/i.test(message)) {
      throw createCodingAgentError("agent_not_authenticated", message);
    }
    throw createCodingAgentError("agent_execution_failed", message);
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    if (/auth|login|credential|api.?key|not.?authenticated/i.test(`${stderr}\n${stdout}`)) {
      throw createCodingAgentError(
        "agent_not_authenticated",
        "Claude Code is not authenticated. Run Claude Code login/auth first."
      );
    }
    throw createCodingAgentError(
      "agent_execution_failed",
      stderr || `Claude Code exited with code ${result.exitCode ?? "unknown"}.`
    );
  }

  if (!parsed.responseText.trim()) {
    const legacy = tryLegacyJsonResult(result);
    if (legacy) {
      return {
        responseText: legacy,
        hasRichToolActivity: parsed.hasRichToolActivity,
        emittedWorkerStarted
      };
    }
    throw createCodingAgentError(
      "agent_execution_failed",
      "Claude Code returned an empty inspection response."
    );
  }

  return {
    responseText: parsed.responseText,
    hasRichToolActivity: parsed.hasRichToolActivity,
    emittedWorkerStarted
  };
}

/**
 * Backward-compatible helper used by older tests — prefers stream-json parse,
 * then legacy single JSON `{ result }`.
 */
export function mapClaudeCodeResult(result: ClaudeCodeProcessResult): {
  responseText: string;
} {
  try {
    const mapped = mapClaudeCodeStreamResult(result, {
      workspace: process.cwd(),
      requestId: "legacy_map"
    });
    return { responseText: mapped.responseText };
  } catch (error) {
    const legacy = tryLegacyJsonResult(result);
    if (legacy) {
      return { responseText: legacy };
    }
    throw error;
  }
}

function tryLegacyJsonResult(result: ClaudeCodeProcessResult): string | undefined {
  const stdout = result.stdout.trim();
  if (!stdout) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      is_error?: unknown;
    };
    if (parsed.is_error === true) {
      return undefined;
    }
    if (typeof parsed.result === "string" && parsed.result.trim()) {
      return parsed.result;
    }
  } catch {
    if (result.exitCode === 0 && !stdout.includes("\n{") && !stdout.startsWith("{")) {
      return stdout;
    }
  }
  return undefined;
}

type RunnerInput = {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onSpawn?: (child: ChildProcess) => void;
  onStdoutChunk?: (chunk: string) => void;
};

async function defaultClaudeCodeProcessRunner(
  input: RunnerInput
): Promise<ClaudeCodeProcessResult> {
  return await runStreamingProcess({
    ...input,
    timeoutMessage: "Coding agent inspection timed out."
  });
}

function isCodingAgentErrorLike(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}
