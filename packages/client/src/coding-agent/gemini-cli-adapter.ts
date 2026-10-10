import { type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { InspectionProgressEvent } from "@pairmesh/protocol";
import { assertCommandAvailable } from "./acp-client.js";
import { GEMINI_CLI_PROVIDER } from "./descriptors.js";
import {
  dedupeGeminiActivityEvents,
  GeminiStreamSession,
  parseGeminiStreamJson
} from "./gemini-stream-activity.js";
import { buildFollowUpInspectionPrompt, buildInspectionPrompt } from "./prompt.js";
import { parseInspectionAgentOutput, validateReferencesInWorkspace } from "./source-references.js";
import { sanitizeFindings, sanitizeInspectionOutput } from "./sanitize.js";
import { runStreamingProcess } from "./streaming-process.js";
import {
  createCodingAgentError,
  type CodingAgentAdapter,
  type CodingAgentAvailability,
  type CodingAgentInspectOptions,
  type CodingAgentProviderDescriptor,
  type CodingAgentRequest,
  type CodingAgentResult
} from "./types.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";

export interface GeminiCliAdapterOptions {
  workspace: string;
  timeoutMs: number;
  command?: string;
  /** Extra args inserted after the command name (before PairMesh defaults). */
  args?: string[];
  /** Test seam — defaults to spawning the real Gemini CLI. */
  runProcess?: GeminiCliProcessRunner;
}

export interface GeminiCliProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type GeminiCliProcessRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onSpawn?: (child: ChildProcess) => void;
    onStdoutChunk?: (chunk: string) => void;
}) => Promise<GeminiCliProcessResult>;

export class GeminiCliAdapter implements CodingAgentAdapter {
  public readonly provider: CodingAgentProviderDescriptor = GEMINI_CLI_PROVIDER;
  private readonly options: GeminiCliAdapterOptions;
  private activeRequestId: string | undefined;
  private activeChild: ChildProcess | undefined;

  public constructor(options: GeminiCliAdapterOptions) {
    this.options = options;
  }

  public async getAvailability(): Promise<CodingAgentAvailability> {
    if (this.activeRequestId) {
      return {
        provider: "gemini-cli",
        configured: true,
        status: "busy",
        reason: "A coding-agent inspection is already in progress."
      };
    }

    const workspace = this.options.workspace?.trim();
    if (!workspace) {
      return {
        provider: "gemini-cli",
        configured: false,
        status: "unavailable",
        reason: "PAIRMESH_WORKSPACE is not configured."
      };
    }

    try {
      await access(resolve(workspace));
    } catch {
      return {
        provider: "gemini-cli",
        configured: false,
        status: "unavailable",
        reason: "Configured workspace does not exist."
      };
    }

    const command = this.options.command ?? "gemini";
    // Test seam: runProcess injects a fake CLI — do not require a real binary on PATH (CI).
    if (!this.options.runProcess) {
      try {
        await assertCommandAvailable(command);
      } catch (error) {
        return {
          provider: "gemini-cli",
          configured: true,
          status: "unavailable",
          reason:
            error instanceof Error ? error.message : "Gemini CLI is not installed or not on PATH."
        };
      }
    }

    return {
      provider: "gemini-cli",
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
        "Gemini CLI coding agent is busy with another inspection."
      );
    }

    this.activeRequestId = request.requestId;
    const startedAt = Date.now();
    let elapsedTimer: NodeJS.Timeout | undefined;
    let richActivitySeen = false;

    const emitActivity = (event: ProviderActivityEvent): void => {
      richActivitySeen = true;
      options?.onProviderActivity?.(event);
    };

    const emitProgress = (event: InspectionProgressEvent): void => {
      if (richActivitySeen && event.phase === "inspecting") {
        return;
      }
      options?.onProgress?.(event);
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
      return await this.runInspection(request, emitProgress, emitActivity, options?.signal);
    } catch (error) {
      emitActivity({
        phase: "failed",
        activityKind: "worker.failed",
        message: "Gemini worker failed.",
        visibility: "requester_safe",
        providerEventId: `${request.requestId}:pairmesh:worker.failed`,
        safeMetadata: { provider: "gemini-cli", correlationId: request.requestId }
      });
      throw error;
    } finally {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
      }
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
    emitActivity: ((event: ProviderActivityEvent) => void) | undefined,
    signal?: AbortSignal
  ): Promise<CodingAgentResult> {
    if (signal?.aborted) {
      throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
    }

    const command = this.options.command ?? "gemini";
    if (!this.options.runProcess) {
      await assertCommandAvailable(command);
    }

    const prompt = buildPromptForRequest(request);
    const args = [
      ...(this.options.args ?? []),
      "--prompt",
      prompt,
      "--output-format",
      "stream-json",
      "--approval-mode",
      "plan"
    ];

    const runner = this.options.runProcess ?? defaultGeminiCliProcessRunner;
    const session = new GeminiStreamSession({
      workspace: this.options.workspace,
      requestId: request.requestId,
      onActivity: emitActivity
    });
    const onAbortFence = (): void => {
      session.fence();
    };
    if (signal) {
      if (signal.aborted) {
        session.fence();
      } else {
        signal.addEventListener("abort", onAbortFence, { once: true });
      }
    }

    let result: GeminiCliProcessResult;
    try {
      result = await runner({
        command,
        args,
        cwd: this.options.workspace,
        signal,
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
      if (signal) {
        signal.removeEventListener("abort", onAbortFence);
      }
      if (isCodingAgentErrorLike(error)) {
        throw error;
      }
      throw createCodingAgentError(
        "agent_execution_failed",
        error instanceof Error ? error.message : "Gemini CLI inspection failed."
      );
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbortFence);
      }
    }

    emitProgress({
      phase: "inspecting",
      message: "Coding agent is inspecting the repository.",
      elapsedMs: 0
    });

    if (signal?.aborted) {
      session.fence();
      throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
    }

    let mapped: { responseText: string; hasRichToolActivity: boolean };
    try {
      mapped = mapGeminiCliStreamResult(result, {
        workspace: this.options.workspace,
        requestId: request.requestId,
        onActivity: emitActivity,
        session
      });
    } finally {
      session.fence();
    }

    const parsed = parseInspectionAgentOutput(mapped.responseText);
    const summary = sanitizeInspectionOutput(parsed.summary || mapped.responseText, {
      workspace: this.options.workspace
    });
    const findings = sanitizeFindings(parsed.findings.length > 0 ? parsed.findings : [summary], {
      workspace: this.options.workspace
    });
    const references = await validateReferencesInWorkspace(
      parsed.references,
      this.options.workspace
    );

    emitActivity?.({
      phase: "completed",
      activityKind: "worker.completed",
      message: "Gemini worker finished.",
      visibility: "requester_safe",
      providerEventId: `${request.requestId}:pairmesh:worker.completed`,
      safeMetadata: {
        provider: "gemini-cli",
        correlationId: request.requestId
      }
    });

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
}

function buildPromptForRequest(request: CodingAgentRequest): string {
  const priorTurns = request.continuation?.priorTurns ?? [];
  if (priorTurns.length > 0 && (request.turnNumber ?? 1) > 1) {
    return buildFollowUpInspectionPrompt(request.question, priorTurns);
  }
  return buildInspectionPrompt(request.question);
}

/**
 * Map Gemini process stdout (stream-json or legacy json) into response + activity emits.
 */
export function mapGeminiCliStreamResult(
  result: GeminiCliProcessResult,
  input: {
    workspace: string;
    requestId: string;
    onActivity?: (event: ProviderActivityEvent) => void;
    session?: GeminiStreamSession;
  }
): { responseText: string; hasRichToolActivity: boolean } {
  let parsed;
  if (input.session) {
    if (input.session.didEmitLiveActivity || input.session.receivedLiveChunks) {
      parsed = input.session.finalize({ emitTrailingFragment: true });
      if (!parsed.responseText.trim() && result.stdout.trim()) {
        const fallback = parseGeminiStreamJson({
          stdout: result.stdout,
          workspace: input.workspace,
          requestId: input.requestId
        });
        parsed = {
          ...parsed,
          responseText: fallback.responseText,
          isError: parsed.isError || fallback.isError,
          errorMessage: parsed.errorMessage ?? fallback.errorMessage,
          sessionId: parsed.sessionId ?? fallback.sessionId,
          model: parsed.model ?? fallback.model
        };
      }
    } else {
      parsed = input.session.consumeBufferedStdout(result.stdout);
    }
  } else {
    parsed = parseGeminiStreamJson({
      stdout: result.stdout,
      workspace: input.workspace,
      requestId: input.requestId
    });
    const activity = dedupeGeminiActivityEvents(parsed.activity);
    for (const event of activity) {
      input.onActivity?.(event);
    }
  }

  if (parsed.isError) {
    const message = parsed.errorMessage ?? "Gemini CLI reported an error.";
    if (/auth|log[\s-]?in|credential|api.?key/i.test(message)) {
      throw createCodingAgentError("agent_not_authenticated", message);
    }
    throw createCodingAgentError("agent_execution_failed", message, {
      exitCode: result.exitCode ?? undefined
    });
  }

  if (result.exitCode !== 0 && !parsed.responseText.trim()) {
    const stderr = result.stderr.trim();
    if (/auth|log[\s-]?in|credential|api.?key/i.test(`${stderr}\n${result.stdout}`)) {
      throw createCodingAgentError(
        "agent_not_authenticated",
        "Gemini CLI is not authenticated. Set GEMINI_API_KEY or complete Gemini CLI login."
      );
    }
    throw createCodingAgentError(
      "agent_execution_failed",
      stderr || `Gemini CLI exited with code ${result.exitCode ?? "unknown"}.`
    );
  }

  if (!parsed.responseText.trim()) {
    throw createCodingAgentError(
      "agent_execution_failed",
      "Gemini CLI returned an empty inspection response."
    );
  }

  return {
    responseText: parsed.responseText,
    hasRichToolActivity: parsed.hasRichToolActivity
  };
}

/** @deprecated Prefer mapGeminiCliStreamResult — kept for older tests expecting JSON-only. */
export function mapGeminiCliResult(result: GeminiCliProcessResult): {
  responseText: string;
} {
  return mapGeminiCliStreamResult(result, {
    workspace: process.cwd(),
    requestId: "legacy"
  });
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

async function defaultGeminiCliProcessRunner(input: RunnerInput): Promise<GeminiCliProcessResult> {
  return await runStreamingProcess({
    ...input,
    timeoutMessage: "Coding agent inspection timed out."
  });
}

function isCodingAgentErrorLike(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}
