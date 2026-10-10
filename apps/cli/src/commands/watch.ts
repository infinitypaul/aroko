import {
  ControlHttpClient,
  buildControlInboxUrl,
  enrichActionForControlInbox,
  enrichInspectionForWatch,
  formatWatchEmptyState,
  formatWatchHeader,
  formatWatchLeavingReviewHoldForNewWork,
  formatWatchReviewHandoff,
  formatWatchSelectionLine,
  formatWatchSelectionPrompt,
  formatWatchTimelineLines,
  formatWatchWaitingState,
  isWatchInspectionCandidate,
  isWatchProposalReviewable,
  isWatchableActiveWork,
  isWatchWorkLive,
  mergeWatchCandidates,
  openControlInboxInBrowser,
  readRuntimeInfo,
  requireActiveRuntime,
  resolveWatchPollIntervalMs,
  diffWatchTimelineKeys,
  shouldKeepWaitingForActiveWork,
  shouldResumeIdleWaitAfterWatch,
  shouldHoldWatchForReviewKeypress,
  shouldReleaseWatchReviewHoldForOtherWork,
  type WatchActionCandidate,
  type WatchCandidate,
  type WatchInspectionCandidate
} from "@pairmesh/client";
import type { ProgressEvent } from "@pairmesh/protocol";
import { createInterface } from "node:readline";
import { flagValue } from "../args.js";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

type ControlActionRow = ReturnType<typeof enrichActionForControlInbox> & {
  kind?: "action";
  progress?: ProgressEvent[];
  peer?: { displayName: string; service?: string; participantId?: string };
  terminal?: boolean;
  status: string;
  actionId: string;
  localService?: string;
};

export async function runWatchCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace);

  let runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo) {
    try {
      runtimeInfo = (await requireActiveRuntime(workspace)).runtimeInfo;
    } catch {
      runtimeInfo = null;
    }
  }
  if (!runtimeInfo?.controlUrl || !runtimeInfo.controlToken) {
    console.log(
      `${productDisplayName()} watch unavailable — run \`${cliBinaryLabel()} start\` first.`
    );
    return;
  }

  const client = new ControlHttpClient({
    baseUrl: runtimeInfo.controlUrl,
    controlToken: runtimeInfo.controlToken
  });
  const localService = await resolveLocalServiceLabel(workspace);
  const once = flags.once === "true";

  let stopRequested = false;
  let stdinRaw = false;
  let waitingPrinted = false;

  const stopWatchingOnly = (): void => {
    stopRequested = true;
  };

  const onSigInt = (): void => {
    // Ctrl+C stops watching only — never cancel/interrupt the worker.
    stopWatchingOnly();
  };
  process.on("SIGINT", onSigInt);

  const onStdinData = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    if (text === "\u0003" || text === "q" || text === "Q") {
      stopWatchingOnly();
    }
  };

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      stdinRaw = true;
      process.stdin.resume();
      process.stdin.on("data", onStdinData);
    } catch {
      stdinRaw = false;
    }
  }

  try {
    while (!stopRequested) {
      const active = await listActiveWatchCandidates(client, localService);

      if (
        shouldKeepWaitingForActiveWork({
          stopRequested,
          once,
          activeCount: active.length
        })
      ) {
        if (!waitingPrinted) {
          console.log(formatWatchEmptyState());
          console.log(formatWatchWaitingState());
          waitingPrinted = true;
        }
        await sleep(resolveWatchPollIntervalMs({ watching: false }));
        continue;
      }

      if (active.length === 0) {
        // `--once` with nothing active: exit cleanly.
        if (!waitingPrinted) {
          console.log(formatWatchEmptyState());
        }
        break;
      }

      waitingPrinted = false;
      let selected: WatchCandidate;
      if (active.length === 1) {
        selected = active[0]!;
      } else {
        // Temporarily leave raw mode so readline selection works.
        if (stdinRaw) {
          process.stdin.off("data", onStdinData);
          try {
            process.stdin.setRawMode(false);
          } catch {
            // ignore
          }
        }
        const choice = await selectActiveWork(active);
        if (stdinRaw) {
          try {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", onStdinData);
          } catch {
            // ignore
          }
        }
        if (!choice || stopRequested) {
          break;
        }
        selected = choice;
      }

      if (isWatchInspectionCandidate(selected)) {
        await watchInspectionLive({
          client,
          requestId: selected.requestId,
          localService,
          once,
          isStopRequested: () => stopRequested,
          onStopKey: onStdinData
        });
      } else {
        await watchActionLive({
          client,
          actionId: selected.actionId,
          controlBaseUrl: runtimeInfo.controlUrl,
          controlToken: runtimeInfo.controlToken,
          localService,
          once,
          isStopRequested: () => stopRequested,
          onOpenReviewKey: onStdinData
        });
      }

      if (
        !shouldResumeIdleWaitAfterWatch({
          stopRequested,
          once
        })
      ) {
        break;
      }
      console.log("");
      console.log(formatWatchWaitingState());
      waitingPrinted = true;
    }
  } finally {
    process.off("SIGINT", onSigInt);
    if (stdinRaw) {
      process.stdin.off("data", onStdinData);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      process.stdin.pause();
    }
  }
}

async function listActiveWatchCandidates(
  client: ControlHttpClient,
  localService?: string
): Promise<WatchCandidate[]> {
  const [listedActions, listedInspections] = await Promise.all([
    client.listActions("active", 50),
    client.listInspections("active", 50)
  ]);
  const actions = normalizeActions(listedActions.actions ?? [], localService).filter(
    isWatchableActiveWork
  ) as WatchActionCandidate[];
  const inspections = normalizeInspections(
    listedInspections.inspections ?? [],
    localService
  ).filter(isWatchableActiveWork) as WatchInspectionCandidate[];
  return mergeWatchCandidates({ actions, inspections }).filter(isWatchableActiveWork);
}

async function watchActionLive(input: {
  client: ControlHttpClient;
  actionId: string;
  controlBaseUrl: string;
  controlToken: string;
  localService?: string;
  once?: boolean;
  isStopRequested: () => boolean;
  onOpenReviewKey: (chunk: Buffer) => void;
}): Promise<void> {
  const seenKeys = new Set<string>();
  let headerPrinted = false;
  let reviewHandoffPrinted = false;
  let reviewOpened = false;

  const openReview = async (): Promise<void> => {
    const { code } = await input.client.mintExchangeCode();
    const url = buildControlInboxUrl(input.controlBaseUrl, code, {
      actionId: input.actionId,
      view: "inbox"
    });
    const opened = await openControlInboxInBrowser(url);
    if (!opened) {
      console.log(`Open Review: ${cliBinaryLabel()} open`);
    } else {
      console.log("Opened Review in Control Inbox.");
    }
    reviewOpened = true;
  };

  const onData = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    if (text === "r" || text === "R") {
      void openReview();
      return;
    }
    input.onOpenReviewKey(chunk);
  };

  if (process.stdin.isTTY) {
    process.stdin.on("data", onData);
  }

  try {
    while (!input.isStopRequested()) {
      const raw = await input.client.getAction(input.actionId);
      const action = normalizeAction(raw, input.localService);
      if (!headerPrinted) {
        for (const line of formatWatchHeader(action)) {
          console.log(line);
        }
        console.log("");
        headerPrinted = true;
      }

      const live = isWatchWorkLive(action) && !action.terminal;
      const lines = formatWatchTimelineLines(action.progress, { live });
      const fresh = diffWatchTimelineKeys(seenKeys, lines);
      for (const line of fresh) {
        seenKeys.add(line.key);
        console.log(`${line.marker} ${line.label}`);
      }

      if (isWatchProposalReviewable(action) && !reviewHandoffPrinted) {
        const alreadyPrintedReady = [...seenKeys].some((key) =>
          lines.some(
            (line) =>
              line.key === key &&
              (line.event.activityKind === "proposal.ready" ||
                line.event.phase === "proposal_ready")
          )
        );
        console.log("");
        for (const line of formatWatchReviewHandoff({
          includeReadyLine: !alreadyPrintedReady
        })) {
          console.log(line);
        }
        reviewHandoffPrinted = true;
      }

      if (input.once) {
        break;
      }

      if (action.terminal) {
        const holdingForReview = shouldHoldWatchForReviewKeypress({
          terminal: true,
          once: input.once,
          stopRequested: input.isStopRequested(),
          reviewHandoffPrinted,
          reviewable: isWatchProposalReviewable(action),
          reviewOpened
        });
        if (holdingForReview) {
          // Finished proposal is not in the active list — any active item is new work.
          const active = await listActiveWatchCandidates(input.client, input.localService);
          if (
            shouldReleaseWatchReviewHoldForOtherWork({
              holdingForReview: true,
              otherActiveCount: active.length
            })
          ) {
            console.log("");
            console.log(formatWatchLeavingReviewHoldForNewWork());
            break;
          }
          await sleep(resolveWatchPollIntervalMs({ watching: false }));
          continue;
        }
        break;
      }

      await sleep(resolveWatchPollIntervalMs({ watching: true, work: action }));
    }
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.off("data", onData);
    }
  }
}

async function watchInspectionLive(input: {
  client: ControlHttpClient;
  requestId: string;
  localService?: string;
  once?: boolean;
  isStopRequested: () => boolean;
  onStopKey: (chunk: Buffer) => void;
}): Promise<void> {
  const seenKeys = new Set<string>();
  let headerPrinted = false;

  if (process.stdin.isTTY) {
    process.stdin.on("data", input.onStopKey);
  }

  try {
    while (!input.isStopRequested()) {
      const raw = await input.client.getInspection(input.requestId);
      const inspection = normalizeInspection(raw, input.localService);
      if (!headerPrinted) {
        for (const line of formatWatchHeader(inspection)) {
          console.log(line);
        }
        console.log("");
        headerPrinted = true;
      }

      const live = isWatchWorkLive(inspection) && !inspection.terminal;
      const lines = formatWatchTimelineLines(inspection.progress, { live });
      const fresh = diffWatchTimelineKeys(seenKeys, lines);
      for (const line of fresh) {
        seenKeys.add(line.key);
        console.log(`${line.marker} ${line.label}`);
      }

      if (input.once || inspection.terminal) {
        break;
      }

      await sleep(resolveWatchPollIntervalMs({ watching: true, work: inspection }));
    }
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.off("data", input.onStopKey);
    }
  }
}

function normalizeActions(raw: unknown[], localService?: string): ControlActionRow[] {
  return raw.map((entry) => normalizeAction(entry, localService));
}

function normalizeAction(raw: unknown, localService?: string): ControlActionRow {
  const enriched = enrichActionForControlInbox(raw as never);
  return {
    ...enriched,
    kind: "action",
    ...(localService ? { localService } : {})
  } as ControlActionRow;
}

function normalizeInspections(raw: unknown[], localService?: string): WatchInspectionCandidate[] {
  return raw.map((entry) => normalizeInspection(entry, localService));
}

function normalizeInspection(raw: unknown, localService?: string): WatchInspectionCandidate {
  const base = enrichInspectionForWatch(raw as never);
  return {
    ...base,
    ...(localService ? { localService } : {})
  };
}

async function resolveLocalServiceLabel(workspace: string): Promise<string | undefined> {
  try {
    const manager = await createSessionManagerFromResolvedConfig(workspace);
    const status = await manager.getSessionStatus();
    const service = status.localParticipant?.serviceLabel?.trim();
    return service || undefined;
  } catch {
    return undefined;
  }
}

async function selectActiveWork(candidates: WatchCandidate[]): Promise<WatchCandidate | undefined> {
  console.log(formatWatchSelectionPrompt());
  console.log("");
  candidates.forEach((candidate, index) => {
    const base = formatWatchSelectionLine(candidate, {
      selected: index === 0
    });
    console.log(base.replace(/^([› ]) /, `$1 ${index + 1}. `));
  });
  console.log("");

  if (!process.stdin.isTTY) {
    console.log("Non-interactive: watching the first active work item.");
    return candidates[0];
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Enter a number (or press Enter for 1): ", (value) => {
      rl.close();
      resolve(value.trim());
    });
  });
  if (!answer) {
    return candidates[0];
  }
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
    console.log("Cancelled.");
    return undefined;
  }
  return candidates[index - 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
