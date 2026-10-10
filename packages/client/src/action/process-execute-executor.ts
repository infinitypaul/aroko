import {
  createPairMeshError,
  type ActionArtifactRecord,
  type ActionExecutionRecord,
  type ActionResult
} from "@pairmesh/protocol";
import type { PairMeshProcessExecutionConfig } from "../local-config/schema.js";
import type { ActionExecutor, ActionExecutorContext, ActionExecutorOutcome } from "./executor.js";
import {
  ProcessExecutionArtifactV1Schema,
  formatProcessCommandDisplay
} from "./process/artifact.js";
import { ProcessExecuteConcurrencyGate } from "./process/concurrency.js";
import {
  computeEnvPolicyDigest,
  computeWorkspaceIdentity,
  resolveProcessExecutable,
  validateProcessCwd
} from "./process/resolve.js";
import {
  runStructuredProcess,
  type ProcessRunnerResult,
  type StructuredProcessRunner
} from "./process/runner.js";
import { writeProcessSpawnJournal, readProcessSpawnJournal } from "./process/spawn-journal.js";
import type { ActionArtifactStore } from "./artifacts.js";

export interface ProcessExecuteExecutorOptions {
  workspaceRoot: string;
  loadProcessConfig: () => Promise<PairMeshProcessExecutionConfig> | PairMeshProcessExecutionConfig;
  artifactStore: ActionArtifactStore;
  runProcess?: StructuredProcessRunner;
  concurrencyGate?: ProcessExecuteConcurrencyGate;
  pathDirectories?: () => string[] | undefined;
}

export class ProcessExecuteExecutor implements ActionExecutor {
  public readonly id = "process-execute-executor";
  public processInvocationCount = 0;
  private readonly workspaceRoot: string;
  private readonly loadProcessConfig: ProcessExecuteExecutorOptions["loadProcessConfig"];
  private readonly artifactStore: ActionArtifactStore;
  private readonly runProcess: StructuredProcessRunner;
  private readonly gate: ProcessExecuteConcurrencyGate;
  private readonly pathDirectories?: () => string[] | undefined;

  public constructor(options: ProcessExecuteExecutorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.loadProcessConfig = options.loadProcessConfig;
    this.artifactStore = options.artifactStore;
    this.runProcess = options.runProcess ?? runStructuredProcess;
    this.gate = options.concurrencyGate ?? new ProcessExecuteConcurrencyGate();
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
          summary: "process.execute cancelled before start.",
          executorInvocationCount: this.processInvocationCount
        }
      };
    }

    const prior = await readProcessSpawnJournal(this.artifactStore.rootDir, execution.actionId);
    if (prior?.phase === "spawn_committed") {
      return {
        result: {
          actionId: execution.actionId,
          status: "unknown_outcome",
          summary:
            "process.execute was interrupted after spawn commitment; outcome is unknown. Not re-run.",
          unknownOutcome: true,
          executorInvocationCount: this.processInvocationCount,
          error: {
            code: "pairmesh.action_unknown_outcome",
            message: "Spawn journal indicates the process may have started."
          }
        }
      };
    }

    const artifactRef = execution.artifactRefs?.[0];
    if (!artifactRef) {
      throw createPairMeshError({
        code: "pairmesh.artifact_not_found",
        message: "process.execute is missing its bound execution artifact."
      });
    }

    const record = (context.sessionState?.actionArtifacts ?? []).find(
      (entry: ActionArtifactRecord) => entry.artifactId === artifactRef.artifactId
    );
    if (!record) {
      throw createPairMeshError({
        code: "pairmesh.artifact_not_found",
        message: "process.execute artifact record not found."
      });
    }
    if (record.contentHash !== artifactRef.contentHash) {
      throw createPairMeshError({
        code: "pairmesh.artifact_hash_mismatch",
        message: "process.execute artifact hash mismatch."
      });
    }

    const bytes = await this.artifactStore.readBytes(record);
    const body = ProcessExecutionArtifactV1Schema.parse(JSON.parse(bytes.toString("utf8")));
    if (body.resolvedExecutableIdentity !== execution.parameters?.resolvedExecutableIdentity) {
      throw createPairMeshError({
        code: "pairmesh.action_binding_mismatch",
        message: "process.execute parameter identity does not match artifact."
      });
    }

    const processConfig = await this.loadProcessConfig();
    const envOverrides = { ...(processConfig.env ?? {}) };
    if (computeEnvPolicyDigest(envOverrides) !== body.envPolicyDigest) {
      throw createPairMeshError({
        code: "pairmesh.process_env_policy_changed",
        message: "Receiver process environment policy changed after approval."
      });
    }
    if (computeWorkspaceIdentity(workspaceRoot) !== body.workspaceIdentity) {
      throw createPairMeshError({
        code: "pairmesh.action_binding_mismatch",
        message: "Workspace identity no longer matches the approved process artifact."
      });
    }

    const cwd = await validateProcessCwd({
      workspaceRoot,
      cwdRelative: body.cwdRelative,
      expectedCwdRelative: body.cwdRelative
    });

    const resolved = await resolveProcessExecutable({
      executableBasename: body.executableBasename,
      workspaceRoot,
      pathDirectories: this.pathDirectories?.()
    });
    if (resolved.identity !== body.resolvedExecutableIdentity) {
      throw createPairMeshError({
        code: "pairmesh.process_executable_changed",
        message: "Resolved executable identity changed after approval."
      });
    }

    // R22-2: late re-check immediately before spawn commitment (TOCTOU).
    // Failures here are deterministic pre-spawn denials — never unknown_outcome.
    const cwdImmediate = await validateProcessCwd({
      workspaceRoot,
      cwdRelative: body.cwdRelative,
      expectedCwdRelative: body.cwdRelative
    });
    const resolvedImmediate = await resolveProcessExecutable({
      executableBasename: body.executableBasename,
      workspaceRoot,
      pathDirectories: this.pathDirectories?.()
    });
    if (resolvedImmediate.identity !== body.resolvedExecutableIdentity) {
      throw createPairMeshError({
        code: "pairmesh.process_executable_changed",
        message: "Resolved executable identity changed immediately before spawn."
      });
    }
    if (cwdImmediate.cwdAbsolute !== cwd.cwdAbsolute) {
      throw createPairMeshError({
        code: "pairmesh.boundary_violation",
        message: "process.execute cwd realpath changed immediately before spawn."
      });
    }

    const release = await this.gate.acquire(processConfig.maxConcurrent);
    this.processInvocationCount += 1;
    const invocation = this.processInvocationCount;

    await writeProcessSpawnJournal(this.artifactStore.rootDir, {
      actionId: execution.actionId,
      phase: "spawn_committed",
      updatedAt: new Date().toISOString()
    });

    let processResult: ProcessRunnerResult;
    try {
      processResult = await this.runProcess({
        executableAbsolute: resolvedImmediate.absolutePath,
        args: [...body.args],
        cwdAbsolute: cwdImmediate.cwdAbsolute,
        timeoutMs: body.timeoutMs,
        maxOutputBytes: body.maxOutputBytes,
        envOverrides,
        workspaceRoot,
        pathDirectories: this.pathDirectories?.(),
        abortSignal: context.abortSignal
      });
    } catch (error) {
      release();
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "pairmesh.process_execution_timeout"
      ) {
        await writeProcessSpawnJournal(this.artifactStore.rootDir, {
          actionId: execution.actionId,
          phase: "completed",
          updatedAt: new Date().toISOString()
        });
        return {
          result: {
            actionId: execution.actionId,
            status: "failed",
            summary: "process.execute timed out.",
            executorInvocationCount: invocation,
            outputs: {
              timedOut: true,
              commandDisplay: formatProcessCommandDisplay(body.executableBasename, body.args),
              executableBasename: body.executableBasename,
              cwdRelative: body.cwdRelative
            },
            error:
              typeof error === "object" && error !== null && "code" in error
                ? (error as ActionResult["error"])
                : undefined
          }
        };
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "pairmesh.action_cancelled"
      ) {
        await writeProcessSpawnJournal(this.artifactStore.rootDir, {
          actionId: execution.actionId,
          phase: "completed",
          updatedAt: new Date().toISOString()
        });
        return {
          result: {
            actionId: execution.actionId,
            status: "cancelled",
            summary: "process.execute cancelled.",
            executorInvocationCount: invocation
          }
        };
      }
      throw error;
    }
    release();

    await writeProcessSpawnJournal(this.artifactStore.rootDir, {
      actionId: execution.actionId,
      phase: "completed",
      updatedAt: new Date().toISOString()
    });

    const display = formatProcessCommandDisplay(body.executableBasename, body.args);
    const exitCode = processResult.exitCode;
    const failed = exitCode !== 0 && exitCode !== null;
    return {
      result: {
        actionId: execution.actionId,
        status: "completed",
        summary: failed
          ? `Command exited with code ${exitCode}.`
          : "Command completed successfully.",
        executorInvocationCount: invocation,
        outputs: {
          commandDisplay: display,
          executableBasename: body.executableBasename,
          argsDisplay: body.args.join("\n"),
          cwdRelative: body.cwdRelative,
          exitCode,
          signal: processResult.signal,
          timedOut: processResult.timedOut,
          durationMs: processResult.durationMs,
          stdout: processResult.stdout,
          stderr: processResult.stderr,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
          truncated: processResult.stdoutTruncated || processResult.stderrTruncated,
          processPassed: !failed
        }
      }
    };
  }
}
