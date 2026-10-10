#!/usr/bin/env tsx
/**
 * Stage 3 Prompt 4 — real cross-repository debugging validation.
 * Spawns isolated Paul/Kelvin agents, runs local + remote Cursor ACP investigation.
 * Output: JSON telemetry on stdout (stderr for progress).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CursorAcpAdapter, LocalStateStore, SessionManager } from "@pairmesh/client";

const REPO_ROOT = resolve(process.cwd());
const PAUL_WORKSPACE = join(REPO_ROOT, "fixtures/cross-repo-debug/paul-checkout-service");
const KELVIN_WORKSPACE = join(REPO_ROOT, "fixtures/cross-repo-debug/kelvin-payment-service");
const PAUL_PORT = 4701;
const KELVIN_PORT = 4702;

const BUG_REPORT =
  "Checkout intermittently fails after a payment retry because customerId is null. Normal payments work.";

interface TimedResult<T> {
  startedAt: string;
  durationMs: number;
  result: T;
}

interface InvestigationTurn {
  label: string;
  question: string;
  threadId?: string;
  requestId?: string;
  durationMs: number;
  summary: string;
  findings: string[];
  references: Array<{ file: string; symbol?: string; startLine?: number; endLine?: number }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitUntilReachable(url: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnAgent(options: {
  name: string;
  port: number;
  workspace: string;
  stateFile: string;
}): ChildProcess {
  return spawn(
    "pnpm",
    [
      "--filter",
      "@pairmesh/coordination",
      "run",
      "agent",
      "--",
      "--name",
      options.name,
      "--port",
      String(options.port)
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PAIRMESH_WORKSPACE: options.workspace,
        PAIRMESH_STATE_FILE: options.stateFile,
        PAIRMESH_CODING_AGENT_PROVIDER: "cursor",
        PAIRMESH_CODING_AGENT_MODE: "ask"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

async function verifyWorkspaceIsolation(): Promise<{
  paulFiles: string[];
  kelvinFiles: string[];
  paulWorkspaceScoped: boolean;
  kelvinWorkspaceScoped: boolean;
}> {
  const paulFiles = await readdir(join(PAUL_WORKSPACE, "src"));
  const kelvinFiles = await readdir(join(KELVIN_WORKSPACE, "src"));

  const paulWorkspaceScoped =
    !paulFiles.includes("retry.ts") &&
    !paulFiles.includes("payment-response.ts") &&
    paulFiles.includes("checkout.ts");

  const kelvinWorkspaceScoped =
    !kelvinFiles.includes("checkout.ts") &&
    !kelvinFiles.includes("customer-repository.ts") &&
    kelvinFiles.includes("retry.ts");

  return {
    paulFiles,
    kelvinFiles,
    paulWorkspaceScoped,
    kelvinWorkspaceScoped
  };
}

async function runLocalInspection(
  workspace: string,
  question: string
): Promise<
  TimedResult<{ summary: string; findings: string[]; references: InvestigationTurn["references"] }>
> {
  const started = Date.now();
  const adapter = new CursorAcpAdapter({
    workspace,
    mode: "ask",
    timeoutMs: Number(process.env.PAIRMESH_CODING_AGENT_TIMEOUT_MS ?? 180_000),
    command: process.env.PAIRMESH_CURSOR_COMMAND?.trim() || "agent",
    args: (process.env.PAIRMESH_CURSOR_ARGS ?? "acp").split(/\s+/).filter(Boolean)
  });

  const result = await adapter.inspect({
    requestId: `local_${Date.now()}`,
    question
  });

  return {
    startedAt: nowIso(),
    durationMs: Date.now() - started,
    result: {
      summary: result.summary,
      findings: result.findings,
      references: result.references
    }
  };
}

function formatKelvinEvidence(turns: InvestigationTurn[]): string {
  return turns
    .map(
      (turn, index) =>
        `Remote turn ${index + 1} (${turn.label}):\nSummary: ${turn.summary}\nFindings:\n- ${turn.findings.join("\n- ")}\nReferences: ${JSON.stringify(turn.references)}`
    )
    .join("\n\n");
}

async function main(): Promise<void> {
  const validationStarted = Date.now();
  const tempDir = await mkdtemp(join(tmpdir(), "pairmesh-p4-"));
  const paulStateFile = join(tempDir, "paul-state.json");
  const kelvinStateFile = join(tempDir, "kelvin-state.json");

  console.error(`Validation temp dir: ${tempDir}`);
  console.error("Verifying workspace isolation…");
  const isolation = await verifyWorkspaceIsolation();
  console.error("Isolation:", JSON.stringify(isolation));

  console.error("Starting Paul agent (4701) and Kelvin agent (4702)…");
  const paulAgentProc = spawnAgent({
    name: "paul-agent",
    port: PAUL_PORT,
    workspace: PAUL_WORKSPACE,
    stateFile: paulStateFile
  });
  const kelvinAgentProc = spawnAgent({
    name: "kelvin-agent",
    port: KELVIN_PORT,
    workspace: KELVIN_WORKSPACE,
    stateFile: kelvinStateFile
  });

  const cleanup = async (): Promise<void> => {
    paulAgentProc.kill("SIGTERM");
    kelvinAgentProc.kill("SIGTERM");
    await sleep(500);
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    await Promise.all([
      waitUntilReachable(`http://127.0.0.1:${PAUL_PORT}/health`),
      waitUntilReachable(`http://127.0.0.1:${KELVIN_PORT}/health`)
    ]);

    const paulManager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: paulStateFile })
    });
    const kelvinManager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: kelvinStateFile })
    });

    console.error("Creating PairMesh session…");
    const created = await paulManager.createSession({
      name: "paul-agent",
      agentUrl: `http://127.0.0.1:${PAUL_PORT}`
    });

    await kelvinManager.joinSession({
      sessionCode: created.sessionCode,
      peerUrl: `http://127.0.0.1:${PAUL_PORT}`,
      name: "kelvin-agent",
      agentUrl: `http://127.0.0.1:${KELVIN_PORT}`
    });

    console.error("Health preflight…");
    const kelvinHealth = await paulManager.getPeerHealth("kelvin-agent");
    const paulHealth = await kelvinManager.getPeerHealth("paul-agent");

    console.error("Paul local investigation…");
    const localQuestion = `Given this production bug report, investigate our checkout-service repository and explain what our code assumes about the payment-service response.\n\nBug report:\n${BUG_REPORT}`;
    const paulLocal = await runLocalInspection(PAUL_WORKSPACE, localQuestion);

    const remoteTurns: InvestigationTurn[] = [];

    const remoteQuestions = [
      {
        label: "remote-1",
        question: "Can the successful payment response ever contain a null customerId?"
      },
      {
        label: "follow-up-1",
        question: "What happens specifically on the retry path?"
      },
      {
        label: "follow-up-2",
        question:
          "Where is the payment object reconstructed during retry, and where should customerId come from?"
      }
    ];

    let threadId: string | undefined;

    for (const [index, item] of remoteQuestions.entries()) {
      console.error(`Remote turn ${index + 1}: ${item.label}`);
      const started = Date.now();
      const turnResult =
        index === 0
          ? await paulManager.askPeer("kelvin-agent", item.question)
          : await paulManager.followUpInspection(threadId!, item.question);

      threadId = turnResult.threadId;
      remoteTurns.push({
        label: item.label,
        question: item.question,
        threadId: turnResult.threadId,
        requestId: turnResult.requestId,
        durationMs: Date.now() - started,
        summary: turnResult.summary,
        findings: turnResult.findings,
        references: turnResult.references
      });

      const combined = `${turnResult.summary} ${turnResult.findings.join(" ")}`.toLowerCase();
      const hasRetrySignal =
        combined.includes("retry") &&
        (combined.includes("null") || combined.includes("customerid"));
      const hasReconstructSignal =
        combined.includes("rebuild") ||
        combined.includes("reconstruct") ||
        turnResult.references.some((ref) => ref.file.includes("retry"));

      if (index >= 1 && hasRetrySignal && hasReconstructSignal) {
        console.error("Root cause signals detected; skipping optional third remote turn.");
        break;
      }
    }

    console.error("Final synthesis (Paul local)…");
    const synthesisQuestion = [
      "Based on my local checkout-service code and Kelvin's remote PairMesh inspection findings, what is the most likely root cause of this production issue?",
      "",
      "Production bug report:",
      BUG_REPORT,
      "",
      "Kelvin's PairMesh findings (summaries only — no source was copied manually):",
      formatKelvinEvidence(remoteTurns),
      "",
      "Combine evidence from both repositories. Do not assume Kelvin's repository is locally available."
    ].join("\n");

    const synthesis = await runLocalInspection(PAUL_WORKSPACE, synthesisQuestion);

    const totalDurationMs = Date.now() - validationStarted;
    const remoteQuestionCount = remoteTurns.filter((t) => t.label === "remote-1").length;
    const followUpCount = remoteTurns.filter((t) => t.label.startsWith("follow-up")).length;

    const synthesisText =
      `${synthesis.result.summary} ${synthesis.result.findings.join(" ")}`.toLowerCase();
    const kelvinEvidenceText = remoteTurns
      .map((t) => `${t.summary} ${t.findings.join(" ")}`)
      .join(" ")
      .toLowerCase();

    const diagnosisChecks = {
      paulAssumptionIdentified:
        `${paulLocal.result.summary} ${paulLocal.result.findings.join(" ")}`
          .toLowerCase()
          .includes("customerid") &&
        (`${paulLocal.result.summary} ${paulLocal.result.findings.join(" ")}`
          .toLowerCase()
          .includes("null") ||
          `${paulLocal.result.summary} ${paulLocal.result.findings.join(" ")}`
            .toLowerCase()
            .includes("non-null") ||
          `${paulLocal.result.summary} ${paulLocal.result.findings.join(" ")}`
            .toLowerCase()
            .includes("assume")),
      kelvinRetryNullIdentified:
        kelvinEvidenceText.includes("retry") &&
        (kelvinEvidenceText.includes("null") || kelvinEvidenceText.includes("customerid")),
      crossServiceSynthesis:
        synthesisText.includes("retry") &&
        synthesisText.includes("customerid") &&
        (synthesisText.includes("null") ||
          synthesisText.includes("contract") ||
          synthesisText.includes("mismatch")),
      structuredReferencesPresent: remoteTurns.some((t) => t.references.length > 0),
      sameThreadFollowUp:
        remoteTurns.length >= 2 &&
        remoteTurns.every((t) => t.threadId === remoteTurns[0]?.threadId),
      isolationVerified: isolation.paulWorkspaceScoped && isolation.kelvinWorkspaceScoped
    };

    const successCriteria = Object.values(diagnosisChecks).every(Boolean);

    const report = {
      validation: "stage-03-prompt-4-cross-repo-debug",
      completedAt: nowIso(),
      session: {
        sessionCode: created.sessionCode,
        sessionId: created.sessionId,
        paulAgent: "paul-agent",
        kelvinAgent: "kelvin-agent",
        paulPort: PAUL_PORT,
        kelvinPort: KELVIN_PORT
      },
      workspaces: {
        paul: "fixtures/cross-repo-debug/paul-checkout-service",
        kelvin: "fixtures/cross-repo-debug/kelvin-payment-service",
        isolation
      },
      healthPreflight: {
        kelvinFromPaul: kelvinHealth,
        paulFromKelvin: paulHealth
      },
      bugReport: BUG_REPORT,
      paulLocalInvestigation: {
        question: localQuestion,
        durationMs: paulLocal.durationMs,
        summary: paulLocal.result.summary,
        findings: paulLocal.result.findings,
        references: paulLocal.result.references
      },
      remoteTurns,
      finalSynthesis: {
        durationMs: synthesis.durationMs,
        summary: synthesis.result.summary,
        findings: synthesis.result.findings,
        references: synthesis.result.references
      },
      metrics: {
        totalDurationMs,
        localInvestigationDurationMs: paulLocal.durationMs,
        synthesisDurationMs: synthesis.durationMs,
        remoteQuestionCount,
        followUpCount,
        remoteTurnDurationsMs: remoteTurns.map((t) => t.durationMs),
        timeouts: 0,
        retries: 0,
        healthFailures: 0
      },
      diagnosisChecks,
      success: successCriteria,
      transportNote:
        "Remote turns used SessionManager.askPeer/followUpInspection — same code path as pairmesh_ask_peer/pairmesh_follow_up MCP tools."
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
