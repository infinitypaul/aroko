import type { ActionArtifactRecord, ActionExecutionRecord, ActionResult } from "@pairmesh/protocol";
import type { ProviderActivityEvent } from "../coding-agent/provider-visibility.js";
import type { FakeExecutorMode } from "./registry.js";

export interface ActionExecutorContext {
  abortSignal?: AbortSignal;
  workspaceRoot?: string;
  artifactStore?: import("./artifacts.js").ActionArtifactStore;
  includeDiffContent?: boolean;
  sessionState?: import("../session/schemas.js").LocalSessionState;
    onProviderActivity?: (event: ProviderActivityEvent) => void;
}

export interface ActionExecutorOutcome {
  result: ActionResult;
  /** New immutable artifacts produced during execution (e.g. change.propose). */
  artifacts?: ActionArtifactRecord[];
}

export interface ActionExecutor {
  readonly id: string;
  execute(
    execution: ActionExecutionRecord,
    context: ActionExecutorContext
  ): Promise<ActionExecutorOutcome>;
}

export class FakeActionExecutor implements ActionExecutor {
  public readonly id = "fake-action-executor";
  public invocationCount = 0;
  public lastActionId?: string;
  private readonly mode: FakeExecutorMode;
  private readonly delayMs: number;

  public constructor(options: { mode?: FakeExecutorMode; delayMs?: number } = {}) {
    this.mode = options.mode ?? "success";
    this.delayMs = options.delayMs ?? (options.mode === "delayed_success" ? 25 : 0);
  }

  public async execute(
    execution: ActionExecutionRecord,
    context: ActionExecutorContext
  ): Promise<ActionExecutorOutcome> {
    this.invocationCount += 1;
    this.lastActionId = execution.actionId;

    if (context.abortSignal?.aborted) {
      return {
        result: {
          actionId: execution.actionId,
          status: "cancelled",
          summary: "Fake executor cancelled before start.",
          executorInvocationCount: this.invocationCount
        }
      };
    }

    if (this.delayMs > 0) {
      await sleep(this.delayMs, context.abortSignal);
    }

    if (context.abortSignal?.aborted || this.mode === "cancel") {
      return {
        result: {
          actionId: execution.actionId,
          status: "cancelled",
          summary: "Fake executor cancelled.",
          executorInvocationCount: this.invocationCount
        }
      };
    }

    switch (this.mode) {
      case "failure":
        return {
          result: {
            actionId: execution.actionId,
            status: "failed",
            summary: "Fake executor failed deliberately.",
            error: { code: "pairmesh.internal_error", message: "Fake failure." },
            executorInvocationCount: this.invocationCount
          }
        };
      case "unknown_outcome":
        return {
          result: {
            actionId: execution.actionId,
            status: "unknown_outcome",
            summary: "Fake executor lost certainty after starting side effects.",
            unknownOutcome: true,
            executorInvocationCount: this.invocationCount
          }
        };
      case "partial_completion":
        return {
          result: {
            actionId: execution.actionId,
            status: "partially_completed",
            summary: "Fake executor reported partial completion without rollback.",
            partial: true,
            outputs: { appliedCount: 1 },
            executorInvocationCount: this.invocationCount
          }
        };
      case "delayed_success":
      case "success":
      default:
        return {
          result: {
            actionId: execution.actionId,
            status: "completed",
            summary: "Fake executor completed without filesystem mutation.",
            outputs: { noop: true, actionType: execution.actionType },
            artifactRefs: execution.artifactRefs,
            executorInvocationCount: this.invocationCount,
            completedAt: new Date().toISOString()
          }
        };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export class ActionExecutorRegistry {
  private readonly executors = new Map<string, ActionExecutor>();

  public register(actionType: string, executor: ActionExecutor): void {
    this.executors.set(actionType, executor);
  }

  public get(actionType: string): ActionExecutor | undefined {
    return this.executors.get(actionType);
  }

  public require(actionType: string): ActionExecutor {
    const executor = this.get(actionType);
    if (!executor) {
      throw new Error(`No executor registered for action type: ${actionType}`);
    }
    return executor;
  }
}
