import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PairMeshSourceReference } from "@pairmesh/protocol";
import { FAKE_PROVIDER } from "./descriptors.js";
import { validateReferencesInWorkspace } from "./source-references.js";
import { sanitizeFindings, sanitizeInspectionOutput } from "./sanitize.js";
import {
  createCodingAgentError,
  resolveProviderSessionId,
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

/**
 * Deterministic CI adapter. Implements the same CodingAgentAdapter contract
 * as real providers without invoking an external CLI.
 */
export class FakeCodingAgentAdapter implements CodingAgentAdapter {
  public readonly provider: CodingAgentProviderDescriptor = FAKE_PROVIDER;
  private readonly workspace: string;
  private readonly invocationCounts = new Map<string, number>();
  private readonly proposeInvocationCounts = new Map<string, number>();
  private readonly progressDelayMs: number;
  private activeRequestId: string | undefined;

  public constructor(workspace: string, progressDelayMs = 0) {
    this.workspace = workspace;
    this.progressDelayMs = progressDelayMs;
  }

  public getInvocationCount(requestId: string): number {
    return this.invocationCounts.get(requestId) ?? 0;
  }

  public getProposeInvocationCount(requestId: string): number {
    return this.proposeInvocationCounts.get(requestId) ?? 0;
  }

  public async getAvailability(): Promise<CodingAgentAvailability> {
    if (this.activeRequestId) {
      return {
        provider: "fake",
        configured: true,
        status: "busy",
        reason: "A coding-agent inspection is already in progress."
      };
    }
    try {
      await access(this.workspace);
      return { provider: "fake", configured: true, status: "available" };
    } catch {
      return {
        provider: "fake",
        configured: false,
        status: "unavailable",
        reason: "Configured workspace does not exist."
      };
    }
  }

  public async proposeChange(
    request: CodingAgentProposeRequest,
    options?: CodingAgentProposeOptions
  ): Promise<CodingAgentProposeResult> {
    if (this.activeRequestId) {
      throw createCodingAgentError("agent_busy", "Fake coding agent is busy with another request.");
    }
    this.activeRequestId = request.requestId;
    try {
      if (options?.signal?.aborted) {
        throw createCodingAgentError("agent_cancelled", "Proposal generation was cancelled.");
      }

      this.proposeInvocationCounts.set(
        request.requestId,
        (this.proposeInvocationCounts.get(request.requestId) ?? 0) + 1
      );

      const emit = options?.onProviderActivity;
      if (emit) {
        const provider = "fake";
        emit({
          phase: "provider_started",
          activityKind: "worker.started",
          message: "Starting fake headless worker.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:worker.started`,
          safeMetadata: { provider, correlationId: request.requestId }
        });
        emit({
          phase: "reading_searching",
          activityKind: "file.read",
          message: "Reading src/retry.ts",
          providerEventId: `${request.requestId}:file.read:retry`,
          safeMetadata: { relativePath: "src/retry.ts", toolName: "Read", provider }
        });
        emit({
          phase: "reading_searching",
          activityKind: "search.started",
          message: "Searching for retryRecord.reference",
          providerEventId: `${request.requestId}:search.started`,
          safeMetadata: { query: "retryRecord.reference", toolName: "Grep", provider }
        });
        emit({
          phase: "reading_searching",
          activityKind: "search.completed",
          message: "Search completed.",
          providerEventId: `${request.requestId}:search.completed`,
          safeMetadata: { query: "retryRecord.reference", toolName: "Grep", provider }
        });
        emit({
          phase: "reading_searching",
          activityKind: "file.read",
          message: "Reading src/payment.ts",
          providerEventId: `${request.requestId}:file.read:payment`,
          safeMetadata: { relativePath: "src/payment.ts", toolName: "Read", provider }
        });
        emit({
          phase: "proposal_preparing",
          activityKind: "proposal.preparing",
          message: "Preparing proposal draft.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:proposal.preparing`,
          safeMetadata: { provider, correlationId: request.requestId }
        });
      }

      const retryPath = join(this.workspace, "src", "retry.ts");
      let source = "";
      try {
        source = await readFile(retryPath, "utf8");
      } catch {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Fake propose requires fixtures/propose-payment-service style src/retry.ts."
        );
      }

      const instruction = request.instruction.toLowerCase();
      if (!(
        instruction.includes("retry") ||
        instruction.includes("payment") ||
        instruction.includes("reference")
      )) {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Fake propose only handles retry/payment-reference repair instructions."
        );
      }

      // Deterministic proposal: restore original payment reference (read-only; no writes).
      const buggy = '    reference: `retry:${retryRecord.customerId ?? "unknown"}`,';
      const fixed = "    reference: retryRecord.reference,";
      if (!source.includes(buggy)) {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Fixture does not contain the expected buggy retry reconstruction line."
        );
      }

      const lines = source.split("\n");
      const lineIndex = lines.findIndex((line) => line === buggy);
      if (lineIndex < 0) {
        throw createCodingAgentError(
          "agent_execution_failed",
          "Could not locate buggy retry reconstruction line for diff generation."
        );
      }
      const start = Math.max(0, lineIndex - 2);
      const end = Math.min(lines.length, lineIndex + 3);
      const oldCount = end - start;
      const hunkLines: string[] = [];
      for (let i = start; i < end; i += 1) {
        const line = lines[i] ?? "";
        if (i === lineIndex) {
          hunkLines.push(`-${buggy}`);
          hunkLines.push(`+${fixed}`);
        } else {
          hunkLines.push(` ${line}`);
        }
      }
      const unifiedDiff = [
        "diff --git a/src/retry.ts b/src/retry.ts",
        "--- a/src/retry.ts",
        "+++ b/src/retry.ts",
        `@@ -${start + 1},${oldCount} +${start + 1},${oldCount} @@`,
        ...hunkLines,
        ""
      ].join("\n");

      if (emit) {
        emit({
          phase: "proposal_ready",
          activityKind: "proposal.ready",
          message: "Proposal ready.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:proposal.ready`,
          safeMetadata: { provider: "fake", correlationId: request.requestId }
        });
        emit({
          phase: "completed",
          activityKind: "worker.completed",
          message: "Fake worker completed.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:worker.completed`,
          safeMetadata: { provider: "fake", correlationId: request.requestId }
        });
      }

      return {
        summary:
          "Preserve the original payment reference when rebuilding a payment from a retry record.",
        unifiedDiff,
        providerMetadata: { mode: "proposal_only", mutatedWorkingTree: false }
      };
    } finally {
      this.activeRequestId = undefined;
    }
  }

  public async inspect(
    request: CodingAgentRequest,
    options?: CodingAgentInspectOptions
  ): Promise<CodingAgentResult> {
    if (this.activeRequestId) {
      throw createCodingAgentError(
        "agent_busy",
        "Fake coding agent is busy with another inspection."
      );
    }

    this.activeRequestId = request.requestId;
    const startedAt = Date.now();

    try {
      if (options?.signal?.aborted) {
        throw createCodingAgentError("agent_cancelled", "Inspection was cancelled.");
      }

      options?.onProgress?.({
        phase: "coding-agent-starting",
        message: "Starting fake coding agent.",
        elapsedMs: 0
      });

      const emit = options?.onProviderActivity;
      if (emit) {
        const provider = "fake";
        emit({
          phase: "provider_started",
          activityKind: "worker.started",
          message: "Starting fake inspection worker.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:worker.started`,
          safeMetadata: { provider, correlationId: request.requestId }
        });
        emit({
          phase: "investigating",
          activityKind: "provider.message",
          message: "I'll inspect the payment flow.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:provider.message:1`,
          safeMetadata: { provider, correlationId: request.requestId }
        });
        emit({
          phase: "reading_searching",
          activityKind: "search.started",
          message: "Searching repository.",
          providerEventId: `${request.requestId}:search.started`,
          safeMetadata: {
            query: "retryRecord.reference",
            toolName: "Grep",
            toolKind: "search",
            provider
          }
        });
        emit({
          phase: "reading_searching",
          activityKind: "search.completed",
          message: "Search completed.",
          providerEventId: `${request.requestId}:search.completed`,
          safeMetadata: {
            query: "retryRecord.reference",
            toolName: "Grep",
            toolKind: "search",
            provider
          }
        });
        emit({
          phase: "reading_searching",
          activityKind: "file.read",
          message: "Reading src/retry.ts",
          providerEventId: `${request.requestId}:file.read:retry`,
          safeMetadata: {
            relativePath: "src/retry.ts",
            toolName: "Read",
            toolKind: "read",
            provider
          }
        });
        emit({
          phase: "reading_searching",
          activityKind: "file.read",
          message: "Reading src/payment.ts",
          providerEventId: `${request.requestId}:file.read:payment`,
          safeMetadata: {
            relativePath: "src/payment.ts",
            toolName: "Read",
            toolKind: "read",
            provider
          }
        });
        emit({
          phase: "reading_searching",
          activityKind: "tool.started",
          message: "Tool started.",
          providerEventId: `${request.requestId}:tool:generic:started`,
          safeMetadata: {
            toolName: "InspectSymbol",
            toolKind: "other",
            toolStatus: "pending",
            provider
          }
        });
        emit({
          phase: "reading_searching",
          activityKind: "tool.in_progress",
          message: "Tool in progress.",
          providerEventId: `${request.requestId}:tool:generic:in_progress`,
          safeMetadata: {
            toolName: "InspectSymbol",
            toolKind: "other",
            toolStatus: "in_progress",
            provider
          }
        });
        emit({
          phase: "reading_searching",
          activityKind: "tool.completed",
          message: "Tool completed.",
          providerEventId: `${request.requestId}:tool:generic:completed`,
          safeMetadata: {
            toolName: "InspectSymbol",
            toolKind: "other",
            toolStatus: "completed",
            provider
          }
        });
        emit({
          phase: "investigating",
          activityKind: "finding",
          message: "Retry handling appears relevant.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:finding:1`,
          safeMetadata: { provider, correlationId: request.requestId }
        });
        emit({
          phase: "reading_searching",
          activityKind: "command.started",
          message: "Command started.",
          providerEventId: `${request.requestId}:command:started`,
          safeMetadata: { commandKind: "shell", toolName: "Shell", provider }
        });
        emit({
          phase: "reading_searching",
          activityKind: "command.completed",
          message: "Command completed.",
          providerEventId: `${request.requestId}:command:completed`,
          safeMetadata: { commandKind: "shell", toolName: "Shell", provider }
        });
        emit({
          phase: "executing",
          activityKind: "test.started",
          message: "Running named tests.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:test.started`,
          safeMetadata: {
            testProfile: "payment-retry",
            testSuite: "payment",
            provider,
            correlationId: request.requestId
          }
        });
        emit({
          phase: "executing",
          activityKind: "test.completed",
          message: "14 passed / 0 failed",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:test.completed`,
          safeMetadata: {
            testProfile: "payment-retry",
            testSuite: "payment",
            passed: 14,
            failed: 0,
            provider,
            correlationId: request.requestId
          }
        });
      }

      if (this.progressDelayMs > 0) {
        await delay(this.progressDelayMs, options?.signal);
      }

      options?.onProgress?.({
        phase: "inspecting",
        message: "Searching repository.",
        elapsedMs: Date.now() - startedAt
      });

      this.invocationCounts.set(
        request.requestId,
        (this.invocationCounts.get(request.requestId) ?? 0) + 1
      );

      const paymentPath = join(this.workspace, "src", "payment.ts");
      let source = "";
      try {
        await access(paymentPath);
        source = await readFile(paymentPath, "utf8");
      } catch {
        // optional for retry-only fixtures
      }

      const question = request.question.toLowerCase();
      const findings: string[] = [];
      let summary = "";
      let references: PairMeshSourceReference[] = buildFakePaymentReferences(question);

      if (
        question.includes("rebuild") &&
        (question.includes("retry") || question.includes("payment"))
      ) {
        summary =
          "rebuildPaymentFromRetryRecord in src/retry.ts rebuilds a payment from a retry record.";
        findings.push("rebuildPaymentFromRetryRecord");
        findings.push("src/retry.ts");
        references = [
          {
            file: "src/retry.ts",
            symbol: "rebuildPaymentFromRetryRecord",
            kind: "function" as const
          }
        ];
      } else if (
        question.includes("customerid") &&
        question.includes("null") &&
        question.includes("retry")
      ) {
        summary =
          "customerId can become null via retryRecord.customerId ?? null in the retry rebuild path.";
        findings.push("retryRecord.customerId ?? null");
        references = [
          {
            file: "src/retry.ts",
            symbol: "rebuildPaymentFromRetryRecord",
            kind: "function" as const
          }
        ];
      } else if (question.includes("webhook") && question.includes("payment")) {
        summary =
          "Webhook handling delegates to buildSuccessfulPaymentResponse to produce the successful payment response.";
        findings.push("src/webhook.ts calls buildSuccessfulPaymentResponse from src/payment.ts.");
        references = [
          {
            file: "src/webhook.ts",
            symbol: "handleWebhookPayment",
            startLine: 3,
            endLine: 5,
            kind: "function"
          },
          {
            file: "src/payment.ts",
            symbol: "buildSuccessfulPaymentResponse",
            startLine: 1,
            endLine: 6,
            kind: "function"
          }
        ];
      } else if (question.includes("paymentreference") && question.includes("where")) {
        summary =
          "paymentReference is mapped from payment.reference in buildSuccessfulPaymentResponse.";
        findings.push("Source field: payment.reference");
        findings.push("Response field: paymentReference in src/payment.ts");
        references = [
          {
            file: "src/payment.ts",
            symbol: "buildSuccessfulPaymentResponse",
            startLine: 3,
            endLine: 4,
            kind: "function"
          }
        ];
      } else if (question.includes("customerid") && question.includes("transform")) {
        summary = "customerId is copied directly from payment.customerId without transformation.";
        findings.push("No transformation is applied before returning customerId.");
      } else if (
        question.includes("field") &&
        (question.includes("payment") || question.includes("response"))
      ) {
        if (source.includes("customerId")) {
          findings.push("Successful payment response includes `customerId`.");
        }
        if (source.includes("paymentReference")) {
          findings.push("Successful payment response includes `paymentReference`.");
        }
        summary = `Inspection for request ${request.requestId}: ${findings.join(" ")}`;
      } else if (request.continuation?.priorTurns && request.continuation.priorTurns.length > 0) {
        summary = `Follow-up inspection using ${request.continuation.priorTurns.length} prior sanitized turn(s).`;
        findings.push(`Answered follow-up: ${request.question}`);
      } else {
        summary = `Inspection for request ${request.requestId}.`;
        findings.push("No specific fixture answer matched the question.");
      }

      if (question.includes(".env") || question.includes("credential")) {
        findings.push("PairMesh safety rules prevented returning secrets.");
      }

      options?.onProgress?.({
        phase: "completed",
        message: "Inspection completed.",
        elapsedMs: Date.now() - startedAt
      });

      if (emit) {
        emit({
          phase: "completed",
          activityKind: "worker.completed",
          message: "Inspection completed.",
          visibility: "requester_safe",
          providerEventId: `${request.requestId}:worker.completed`,
          safeMetadata: { provider: "fake", correlationId: request.requestId }
        });
      }

      const sanitizedSummary = sanitizeInspectionOutput(summary, { workspace: this.workspace });
      const validatedReferences = await validateReferencesInWorkspace(references, this.workspace);
      const providerSessionId =
        resolveProviderSessionId(request.continuation) ??
        `fake_session_${request.threadId ?? request.requestId}`;

      return {
        summary: sanitizedSummary,
        findings: sanitizeFindings(findings, { workspace: this.workspace }),
        references: validatedReferences,
        providerSessionId,
        continuityMode: request.continuation?.priorTurns?.length
          ? "sanitized_history_fallback"
          : "native_provider_session"
      };
    } finally {
      this.activeRequestId = undefined;
    }
  }
}

function buildFakePaymentReferences(question: string) {
  if (
    question.includes("field") &&
    (question.includes("payment") || question.includes("response"))
  ) {
    return [
      {
        file: "src/payment.ts",
        symbol: "buildSuccessfulPaymentResponse",
        startLine: 1,
        endLine: 6,
        kind: "function" as const
      }
    ];
  }
  return [];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
        },
        { once: true }
      );
    }
  });
}
