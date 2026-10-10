import {
  createPairMeshError,
  type ActionExecutionRecord,
  type ActionResult
} from "@pairmesh/protocol";
import type { PairMeshTestsConfig } from "../local-config/schema.js";
import { mayIncludeSourceReferences } from "../auth/capabilities.js";
import type { ActionExecutor, ActionExecutorContext, ActionExecutorOutcome } from "./executor.js";
import {
  runProfileProcess,
  type ProfileProcessResult,
  type ProfileProcessRunner
} from "./tests/process-runner.js";
import { TestsRunConcurrencyGate } from "./tests/concurrency.js";
import { resolveTestProfile, type ResolvedTestProfile } from "./tests/profile.js";

export interface TestsRunExecutorOptions {
  workspaceRoot: string;
  loadTestsConfig: () => Promise<PairMeshTestsConfig> | PairMeshTestsConfig;
  runProcess?: ProfileProcessRunner;
  concurrencyGate?: TestsRunConcurrencyGate;
  /** Optional controlled PATH directories (tests / advanced receivers). */
  pathDirectories?: () => string[] | undefined;
}

export class TestsRunExecutor implements ActionExecutor {
  public readonly id = "tests-run-executor";
  public processInvocationCount = 0;
  private readonly workspaceRoot: string;
  private readonly loadTestsConfig: TestsRunExecutorOptions["loadTestsConfig"];
  private readonly runProcess: ProfileProcessRunner;
  private readonly gate: TestsRunConcurrencyGate;
  private readonly pathDirectories?: () => string[] | undefined;

  public constructor(options: TestsRunExecutorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.loadTestsConfig = options.loadTestsConfig;
    this.runProcess = options.runProcess ?? runProfileProcess;
    this.gate = options.concurrencyGate ?? new TestsRunConcurrencyGate();
    this.pathDirectories = options.pathDirectories;
  }

  public async execute(
    execution: ActionExecutionRecord,
    context: ActionExecutorContext
  ): Promise<ActionExecutorOutcome> {
    const workspaceRoot = context.workspaceRoot ?? this.workspaceRoot;
    if (context.abortSignal?.aborted) {
      return {
        result: {
          actionId: execution.actionId,
          status: "cancelled",
          summary: "tests.run cancelled before start.",
          executorInvocationCount: this.processInvocationCount
        }
      };
    }

    let profile: ResolvedTestProfile;
    let maxConcurrent = 1;
    try {
      const boundName =
        typeof execution.parameters?.profile === "string"
          ? execution.parameters.profile.trim()
          : "";
      if (!boundName) {
        throw createPairMeshError({
          code: "pairmesh.test_profile_invalid",
          message: "tests.run execution is missing bound profile name."
        });
      }
      const testsConfig = await this.loadTestsConfig();
      maxConcurrent = testsConfig.maxConcurrent;
      profile = await resolveTestProfile({
        name: boundName,
        testsConfig,
        workspaceRoot,
        pathDirectories: this.pathDirectories?.()
      });
      const boundDigest = execution.parameters?.profileDigest;
      if (typeof boundDigest !== "string" || boundDigest !== profile.digest) {
        throw createPairMeshError({
          code: "pairmesh.test_profile_changed",
          message: "Test profile definition changed since this action was bound."
        });
      }
    } catch (error) {
      return { result: mapFailure(execution.actionId, error, this.processInvocationCount) };
    }

    let release: (() => void) | undefined;
    try {
      release = await this.gate.acquire(workspaceRoot, maxConcurrent);
    } catch (error) {
      return { result: mapFailure(execution.actionId, error, this.processInvocationCount) };
    }

    this.processInvocationCount += 1;
    try {
      const processResult = await this.runProcess(profile, {
        abortSignal: context.abortSignal,
        workspaceRoot,
        pathDirectories: this.pathDirectories?.()
      });
      return {
        result: buildCompletedResult(
          execution,
          profile,
          processResult,
          this.processInvocationCount,
          context
        )
      };
    } catch (error) {
      if (isCode(error, "pairmesh.action_cancelled")) {
        return {
          result: {
            actionId: execution.actionId,
            status: "cancelled",
            summary: "tests.run cancelled.",
            outputs: {
              actionType: "tests.run",
              profileName: profile.name,
              profileDigest: profile.digest
            },
            executorInvocationCount: this.processInvocationCount
          }
        };
      }
      if (isCode(error, "pairmesh.test_execution_timeout")) {
        return {
          result: {
            actionId: execution.actionId,
            status: "failed",
            summary: `Profile '${profile.name}' timed out.`,
            outputs: {
              actionType: "tests.run",
              profileName: profile.name,
              profileDigest: profile.digest,
              timedOut: true
            },
            error: {
              code: "pairmesh.test_execution_timeout",
              message: `Profile '${profile.name}' timed out.`
            },
            executorInvocationCount: this.processInvocationCount
          }
        };
      }
      return { result: mapFailure(execution.actionId, error, this.processInvocationCount) };
    } finally {
      release?.();
    }
  }
}

function buildCompletedResult(
  execution: ActionExecutionRecord,
  profile: ResolvedTestProfile,
  processResult: ProfileProcessResult,
  invocationCount: number,
  context: ActionExecutorContext
): ActionResult {
  const testPassed = processResult.exitCode === 0;
  const includePaths =
    typeof context.includeDiffContent === "boolean"
      ? context.includeDiffContent
      : context.sessionState
        ? mayIncludeSourceReferences(context.sessionState, execution.requesterParticipantId)
        : false;

  const outputs: Record<string, string | number | boolean | null> = {
    actionType: "tests.run",
    profileName: profile.name,
    profileDigest: profile.digest,
    exitCode: processResult.exitCode ?? -1,
    testPassed,
    durationMs: processResult.durationMs,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
    stdoutTruncated: processResult.stdoutTruncated,
    stderrTruncated: processResult.stderrTruncated,
    sourceReferencesAllowed: includePaths
  };
  outputs.stdout = processResult.stdout.slice(0, profile.maxOutputBytes);
  outputs.stderr = processResult.stderr.slice(0, profile.maxOutputBytes);

  return {
    actionId: execution.actionId,
    status: "completed",
    summary: testPassed
      ? `Profile '${profile.name}' passed.`
      : `Profile '${profile.name}' failed (exit ${processResult.exitCode ?? "null"}).`,
    outputs,
    executorInvocationCount: invocationCount,
    completedAt: new Date().toISOString()
  };
}

function mapFailure(
  actionId: ActionExecutionRecord["actionId"],
  error: unknown,
  invocationCount: number
): ActionResult {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("pairmesh.")
  ) {
    const code = (error as { code: string }).code;
    const message =
      "message" in error && typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : "tests.run failed.";
    return {
      actionId,
      status: "failed",
      summary: message.slice(0, 2000),
      error: { code, message: message.slice(0, 500) },
      executorInvocationCount: invocationCount
    };
  }
  return {
    actionId,
    status: "failed",
    summary: "tests.run failed.",
    error: {
      code: "pairmesh.test_execution_failed",
      message: "tests.run failed."
    },
    executorInvocationCount: invocationCount
  };
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
