import type { ClientFactory } from "@a2a-js/sdk/client";
import { type Message, type Task, TaskState } from "@a2a-js/sdk";
import {
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PairMeshInspectionRequestSchema,
  createPairMeshError,
  parsePairMeshMetadata,
  type InspectionThreadId,
  type PairMeshInspectionRequest,
  type PairMeshInspectionResponse
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { discoverA2AAgentCard } from "./adapter.js";
import { createPairMeshA2AClient } from "./client-factory.js";
import {
  agentCardHasPairMeshInspectSkill,
  encodePairMeshInspectionRequest
} from "./inspection-messages.js";
import { parsePairMeshPayloadFromMessage } from "./pairing-messages.js";
import { normalizeAgentBaseUrl } from "../identity.js";
import {
  extractInspectionResponseFromTask,
  extractTaskId,
  isTerminalA2ATaskState,
  normalizeA2ATaskState
} from "./task-lifecycle.js";

export interface InspectionSendResult {
  target: string;
  request: PairMeshInspectionRequest;
  response: PairMeshInspectionResponse;
}

export interface InspectionTaskStartResult {
  target: string;
  request: PairMeshInspectionRequest;
  a2aTaskId: string;
  remoteTaskState: ReturnType<typeof normalizeA2ATaskState>;
}

export interface InspectionTaskPollResult {
  task: Task;
  remoteTaskState: ReturnType<typeof normalizeA2ATaskState>;
  response?: PairMeshInspectionResponse;
  taskEvicted?: boolean;
}

export interface InspectionInteractiveResult {
  target: string;
  a2aTaskId: string;
  completed: boolean;
  remoteTaskState: ReturnType<typeof normalizeA2ATaskState>;
  response?: PairMeshInspectionResponse;
  task?: Task;
}

export interface InspectionSendOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
    bearerToken?: string;
}

const DEFAULT_INSPECTION_TIMEOUT_MS = 130_000;

export async function runPairMeshInspectionInteractive(
  targetAgentUrl: string,
  request: PairMeshInspectionRequest,
  options: InspectionSendOptions = {}
): Promise<InspectionInteractiveResult> {
  const baseUrl = normalizeAgentBaseUrl(targetAgentUrl);
  const agentCard = await discoverA2AAgentCard(baseUrl);
  assertPairMeshInspectSkill(agentCard);

  const client = await createPairMeshA2AClient(baseUrl, options.bearerToken);
  const controller = new AbortController();
  const interactiveWaitMs = options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;

  if (options.signal) {
    if (options.signal.aborted) {
      throw createPairMeshError({
        code: "pairmesh.inspection_cancelled",
        message: "Inspection was cancelled before reaching the peer."
      });
    }
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let a2aTaskId: string | undefined;
  let latestTask: Task | undefined;
  let latestResponse: PairMeshInspectionResponse | undefined;

  try {
    const { getReliabilityTracker } = await import("../reliability/tracker.js");
    const tracker = getReliabilityTracker();
    const delivery = tracker.begin("request.delivery", {
      transport: "relay",
      replacePrior: true,
      phase: "send"
    });

    const started = await client.sendMessage(
      {
        tenant: "",
        message: encodePairMeshInspectionRequest(request),
        configuration: {
          acceptedOutputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE, "text/plain"],
          taskPushNotificationConfig: undefined,
          historyLength: 10,
          returnImmediately: true
        },
        metadata: { "pairmesh.skill": "pairmesh.inspect" }
      },
      { signal: controller.signal }
    );

    a2aTaskId = extractTaskId(started);
    // Delivery stops when remote PairMesh runtime has accepted the A2A task —
    // before coding-agent execution completes.
    if (a2aTaskId) {
      tracker.complete(delivery.id, { outcome: "success", phase: "remote_accepted" });
    } else {
      tracker.complete(delivery.id, { outcome: "failed", reason: "no_task_id" });
    }
    if ("status" in started && started.status) {
      latestTask = started as Task;
      latestResponse = extractInspectionResponseFromTask(latestTask);
    }

    let taskEvicted = false;
    if (a2aTaskId && !latestResponse?.accepted) {
      const drained = await pollTaskUntilResponse(
        client,
        a2aTaskId,
        interactiveWaitMs,
        options.pollIntervalMs ?? 50,
        options.signal
      );
      latestTask = drained.task;
      latestResponse = drained.response ?? latestResponse;
      taskEvicted = drained.taskEvicted === true;
    }

    if (
      !latestResponse?.accepted &&
      (taskEvicted || isTerminalA2ATaskState(latestTask?.status?.state))
    ) {
      const recovered = await resendInspectionForCachedResult(baseUrl, request, {
        timeoutMs: 3_000,
        signal: options.signal,
        bearerToken: options.bearerToken
      });
      if (recovered) {
        latestResponse = recovered;
      }
    }
  } catch (error) {
    if (controller.signal.aborted && options.signal?.aborted) {
      throw createPairMeshError({
        code: "pairmesh.inspection_cancelled",
        message: "Inspection was cancelled."
      });
    }
    throw translateTransportError(error);
  }

  if (!a2aTaskId) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh inspection did not return an A2A task id."
    });
  }

  const remoteTaskState = normalizeA2ATaskState(latestTask?.status?.state);
  return {
    target: baseUrl,
    a2aTaskId,
    completed: latestResponse?.accepted === true,
    remoteTaskState,
    ...(latestResponse ? { response: latestResponse } : {}),
    ...(latestTask ? { task: latestTask } : {})
  };
}

export async function getPairMeshInspectionTask(
  targetAgentUrl: string,
  a2aTaskId: string,
  options: Pick<InspectionSendOptions, "signal" | "timeoutMs" | "bearerToken"> = {}
): Promise<InspectionTaskPollResult> {
  // Wrap card discovery + GetTask so stale reminted egress (ECONNREFUSED / fetch failed)
  // becomes peer_transport_unavailable — not an uncaught TypeError that aborts wait.
  try {
    const baseUrl = normalizeAgentBaseUrl(targetAgentUrl);
    const client = await createPairMeshA2AClient(baseUrl, options.bearerToken);
    const task = await client.getTask(
      { tenant: "", id: a2aTaskId, historyLength: 10 },
      options.signal ? { signal: options.signal } : undefined
    );
    // Provider SDKs occasionally return an empty/malformed task; guard before .status.
    if (!task || typeof task !== "object") {
      return {
        task: buildWorkingTask(a2aTaskId),
        remoteTaskState: "working",
        taskEvicted: true
      };
    }
    const remoteTaskState = normalizeA2ATaskState(task.status?.state);
    const response = extractInspectionResponseFromTask(task);
    return { task, remoteTaskState, ...(response ? { response } : {}) };
  } catch (error) {
    if (!isTaskNotFoundError(error)) {
      throw translatePollTransportError(error);
    }
  }

  return {
    task: buildWorkingTask(a2aTaskId),
    remoteTaskState: "working",
    taskEvicted: true
  };
}

export async function cancelPairMeshInspectionTask(
  targetAgentUrl: string,
  a2aTaskId: string,
  bearerToken?: string
): Promise<Task> {
  const baseUrl = normalizeAgentBaseUrl(targetAgentUrl);
  const client = await createPairMeshA2AClient(baseUrl, bearerToken);
  return await client.cancelTask({ tenant: "", id: a2aTaskId, metadata: undefined });
}

export async function waitForPairMeshInspectionTask(
  targetAgentUrl: string,
  a2aTaskId: string,
  options: InspectionSendOptions = {}
): Promise<InspectionTaskPollResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) {
      throw createPairMeshError({
        code: "pairmesh.inspection_cancelled",
        message: "Inspection was cancelled."
      });
    }

    const polled = await getPairMeshInspectionTask(targetAgentUrl, a2aTaskId, {
      signal: options.signal,
      timeoutMs: Math.min(2_000, timeoutMs),
      bearerToken: options.bearerToken
    });
    if (polled.response?.accepted) {
      return polled;
    }
    if (polled.response && !polled.response.accepted) {
      return polled;
    }
    if (
      isTerminalA2ATaskState(polled.task.status?.state) &&
      polled.remoteTaskState !== "working" &&
      polled.remoteTaskState !== "submitted"
    ) {
      return polled;
    }

    await delay(pollIntervalMs, options.signal);
  }

  return await getPairMeshInspectionTask(targetAgentUrl, a2aTaskId, {
    signal: options.signal,
    timeoutMs: 2_000,
    bearerToken: options.bearerToken
  }).catch(() => ({
    task: buildWorkingTask(a2aTaskId),
    remoteTaskState: "working" as const
  }));
}

export async function startPairMeshInspectionTask(
  targetAgentUrl: string,
  request: PairMeshInspectionRequest,
  options: InspectionSendOptions = {}
): Promise<InspectionTaskStartResult> {
  const interactive = await runPairMeshInspectionInteractive(targetAgentUrl, request, {
    ...options,
    timeoutMs: 1
  });
  return {
    target: interactive.target,
    request,
    a2aTaskId: interactive.a2aTaskId,
    remoteTaskState: interactive.remoteTaskState
  };
}

/** Blocking resend with the same requestId — receiver returns cached turn result when complete. */
export async function resendInspectionForCachedResult(
  targetAgentUrl: string,
  request: PairMeshInspectionRequest,
  options: InspectionSendOptions = {}
): Promise<PairMeshInspectionResponse | undefined> {
  const baseUrl = normalizeAgentBaseUrl(targetAgentUrl);
  const client = await createPairMeshA2AClient(baseUrl, options.bearerToken);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const result = await client.sendMessage(
      {
        tenant: "",
        message: encodePairMeshInspectionRequest(request),
        configuration: {
          acceptedOutputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE, "text/plain"],
          taskPushNotificationConfig: undefined,
          historyLength: 10,
          returnImmediately: false
        },
        metadata: { "pairmesh.skill": "pairmesh.inspect" }
      },
      { signal: controller.signal }
    );

    if ("status" in result) {
      return extractInspectionResponseFromTask(result as Task);
    }

    const envelope = parsePairMeshPayloadFromMessage(result as Message);
    return envelope?.type === "pairmesh.inspect.response" ? envelope.payload : undefined;
  } catch (error) {
    if (controller.signal.aborted) {
      return undefined;
    }
    throw translateTransportError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** @deprecated Prefer startPairMeshInspectionTask + waitForPairMeshInspectionTask. */
export async function sendPairMeshInspectionRequest(
  targetAgentUrl: string,
  request: PairMeshInspectionRequest,
  options: InspectionSendOptions = {}
): Promise<InspectionSendResult> {
  const started = await startPairMeshInspectionTask(targetAgentUrl, request, options);
  const finished = await waitForPairMeshInspectionTask(targetAgentUrl, started.a2aTaskId, options);

  if (!finished.response) {
    if (finished.task.status?.state === TaskState.TASK_STATE_CANCELED) {
      throw createPairMeshError({
        code: "pairmesh.inspection_cancelled",
        message: "Inspection was cancelled."
      });
    }
    if (
      finished.task.status?.state === TaskState.TASK_STATE_FAILED ||
      finished.task.status?.state === TaskState.TASK_STATE_REJECTED
    ) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "Remote inspection task failed."
      });
    }
    throw createPairMeshError({
      code: "pairmesh.inspection_timeout",
      message: "Inspection timed out waiting for the peer's coding agent.",
      details: { timeoutMs: options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS }
    });
  }

  return {
    target: started.target,
    request,
    response: finished.response
  };
}

export function assertPairMeshInspectSkill(agentCard: { skills: Array<{ id: string }> }): void {
  if (!agentCardHasPairMeshInspectSkill(agentCard)) {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "Peer agent does not expose PairMesh inspect capability.",
      details: { requiredSkill: "pairmesh.inspect" }
    });
  }
}

export function buildInspectionRequest(
  sessionId: string,
  threadId: InspectionThreadId,
  question: string,
  turnNumber: number,
  requestId?: string
): PairMeshInspectionRequest {
  const parsed = parsePairMeshMetadata(PairMeshInspectionRequestSchema, {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    sessionId,
    threadId,
    requestId: requestId ?? `req_${randomUUID()}`,
    question: question.trim(),
    turnNumber
  });

  if (!parsed.ok) {
    throw parsed.error;
  }

  return parsed.value;
}

async function pollTaskUntilResponse(
  client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>,
  a2aTaskId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal
): Promise<InspectionTaskPollResult> {
  const started = Date.now();
  let latest: InspectionTaskPollResult | undefined;

  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) {
      throw createPairMeshError({
        code: "pairmesh.inspection_cancelled",
        message: "Inspection was cancelled."
      });
    }

    try {
      const task = await client.getTask(
        { tenant: "", id: a2aTaskId, historyLength: 10 },
        signal ? { signal } : undefined
      );
      const response = extractInspectionResponseFromTask(task);
      latest = {
        task,
        remoteTaskState: normalizeA2ATaskState(task.status?.state),
        ...(response ? { response } : {})
      };
      if (response?.accepted) {
        return latest;
      }
      if (response && !response.accepted) {
        return latest;
      }
      if (isTerminalA2ATaskState(task.status?.state) && response) {
        return latest;
      }
    } catch (error) {
      if (isTaskNotFoundError(error)) {
        if (Date.now() - started < 1_000) {
          await delay(pollIntervalMs, signal);
          continue;
        }
        if (latest?.response) {
          return latest;
        }
        return {
          task: buildWorkingTask(a2aTaskId),
          remoteTaskState: "working",
          taskEvicted: true
        };
      }
      throw translateTransportError(error);
    }

    await delay(pollIntervalMs, signal);
  }

  return (
    latest ?? {
      task: buildWorkingTask(a2aTaskId),
      remoteTaskState: "working",
      taskEvicted: latest === undefined
    }
  );
}

function buildWorkingTask(a2aTaskId: string): Task {
  return {
    id: a2aTaskId,
    contextId: "",
    status: {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [],
    metadata: {}
  };
}

function isTaskNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Task not found");
}

function translateTransportError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("pairmesh.authentication_required")) {
    throw createPairMeshError({
      code: "pairmesh.authentication_required",
      message: "Peer requires a PairMesh session credential for this request."
    });
  }
  if (message.includes("pairmesh.authentication_failed")) {
    throw createPairMeshError({
      code: "pairmesh.authentication_failed",
      message: "Peer rejected the PairMesh session credential. Re-pair with a fresh invite."
    });
  }
  if (
    message.includes("peer_transport_unavailable") ||
    message.includes("pairmesh.peer_transport_unavailable")
  ) {
    throw createPairMeshError({
      code: "pairmesh.peer_transport_unavailable",
      message:
        "Peer transport is temporarily unavailable. The remote agent may still be working — continue with the same requestId when the route recovers (do not start a new ask).",
      details: { transportError: message }
    });
  }
  if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
    throw createPairMeshError({
      code: "pairmesh.peer_unreachable",
      message: "Peer PairMesh agent became unreachable during inspection.",
      details: { transportError: message }
    });
  }
  throw error;
}

/**
 * GetTask / status-poll path: stale reminted egress and transient relay 502s are
 * transport recovery cases — waitForInspection retries without fabricating timed_out.
 */
function translatePollTransportError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error && error.cause instanceof Error
      ? error.cause.message
      : "";
  const combined = `${message} ${cause}`;
  if (
    combined.includes("fetch failed") ||
    combined.includes("ECONNREFUSED") ||
    combined.includes("ECONNRESET") ||
    combined.includes("ETIMEDOUT") ||
    combined.includes("502") ||
    combined.includes("egress closed") ||
    combined.includes("peer_transport_unavailable")
  ) {
    throw createPairMeshError({
      code: "pairmesh.peer_transport_unavailable",
      message:
        "Peer transport is temporarily unavailable. The remote agent may still be working — continue with the same requestId when the route recovers (do not start a new ask).",
      details: { transportError: combined.trim() }
    });
  }
  translateTransportError(error);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(
          createPairMeshError({
            code: "pairmesh.inspection_cancelled",
            message: "Inspection was cancelled."
          })
        );
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(
            createPairMeshError({
              code: "pairmesh.inspection_cancelled",
              message: "Inspection was cancelled."
            })
          );
        },
        { once: true }
      );
    }
  });
}
