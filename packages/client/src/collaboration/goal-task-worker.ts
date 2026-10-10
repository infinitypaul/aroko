import type { ChildProcess } from "node:child_process";
import { dirname, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTINUATION_MAX_SUMMARY_CHARS,
  createPairMeshError,
  type TaskWorkerEnvelope
} from "@pairmesh/protocol";
import { AcpJsonRpcClient, assertCommandAvailable } from "../coding-agent/acp-client.js";
import type { CursorAcpClient } from "../coding-agent/cursor-adapter.js";
import { runStreamingProcess } from "../coding-agent/streaming-process.js";
import type { TaskWorker, TaskWorkerTurnResult } from "./continuation-orchestrator.js";
import { FakeTaskWorker } from "./fake-task-worker.js";
import {
  buildClaudeGoalAllowedTools,
  buildCursorGoalAcpMcpServers,
  writeClaudeGoalMcpConfigFile,
  type GoalHostMcpLaunch
} from "./goal-host-mcp-config.js";
import {
  PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME,
  provisionGeminiGoalMcp,
  restoreGeminiGoalMcp
} from "./gemini-goal-mcp-provision.js";
import {
  normalizeHostToolName,
  parseHostToolCall,
  PAIRMESH_GOAL_HOST_TOOLS
} from "./goal-host-tools.js";
import { buildGoalTurnPrompt } from "./goal-prompt.js";

export type GoalProviderId = "fake" | "claude-code" | "cursor" | "gemini-cli";

export interface ClaudeGoalTurnInput {
  prompt: string;
  workspace: string;
  signal?: AbortSignal;
  /** Optional MCP config path for PairMesh host tools. */
  mcpConfigPath?: string;
}

export interface ClaudeGoalTurnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** OS pid of the Claude process when spawned (live path). */
  pid?: number;
}

export type ClaudeGoalTurnRunner = (input: ClaudeGoalTurnInput) => Promise<ClaudeGoalTurnResult>;

export interface CursorGoalTurnInput {
  prompt: string;
  workspace: string;
  signal?: AbortSignal;
  disableSessionReuse: boolean;
}

export type CursorGoalAcpFactory = (input: {
  workspace: string;
  signal?: AbortSignal;
}) => CursorAcpClient | Promise<CursorAcpClient>;

export interface GeminiGoalTurnInput {
  prompt: string;
  workspace: string;
  signal?: AbortSignal;
}

export type GeminiGoalTurnRunner = (input: GeminiGoalTurnInput) => Promise<TaskWorkerTurnResult>;

export interface CursorAcpMcpServerEntry {
  name: string;
  command: string;
  args: string[];
  /** ACP session/new expects env as [{name,value}], not a record. */
  env: Array<{ name: string; value: string }>;
}

export interface GoalTaskWorkerOptions {
  providerId: GoalProviderId;
  workspaceRoot: string;
  /** For Fake — scripted FakeTaskWorker */
  fakeWorker?: FakeTaskWorker;
  /** Disable Cursor session/load reuse (default true for goal mode) */
  disableCursorSessionReuse?: boolean;
  /** Optional Claude MCP config for host tools; live path auto-writes one when omitted */
  claudeMcpConfigPath?: string;
  /** Optional Cursor ACP mcpServers; live path defaults to PairMesh goal host MCP */
  cursorMcpServers?: CursorAcpMcpServerEntry[];
  /** Cursor ACP command (default `agent`) */
  cursorCommand?: string;
  /** Cursor ACP args (default `["acp"]`) */
  cursorArgs?: string[];
  /** Skip auto MCP wiring (unit tests that inject runners / ACP doubles) */
  skipAutoGoalMcp?: boolean;
  timeoutMs?: number;
  /** Test seams */
  runClaude?: ClaudeGoalTurnRunner;
  createCursorAcpClient?: CursorGoalAcpFactory;
  runGemini?: GeminiGoalTurnRunner;
  /** Optional override for MCP launch (node path / entry) */
  goalHostMcpLaunch?: GoalHostMcpLaunch;
}

function boundSummary(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "Provider completed without a summary.";
  }
  if (trimmed.length <= CONTINUATION_MAX_SUMMARY_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, CONTINUATION_MAX_SUMMARY_CHARS);
}

function sanitizeProviderText(value: string): string {
  return boundSummary(
    value
      .replace(/providerSessionRef/gi, "[redacted]")
      .replace(/controlToken/gi, "[redacted]")
      .replace(/bearerToken/gi, "[redacted]")
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Scan Claude stream-json NDJSON for the first PairMesh host request tool_use.
 */
export function extractClaudeHostToolUse(
  stdout: string
): { toolName: string; args: unknown } | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) {
      continue;
    }
    const message = asRecord(root.message) ?? root;
    const content = message.content;
    if (!Array.isArray(content)) {
      // Also accept top-level tool_use events.
      if (asString(root.type) === "tool_use") {
        const name = asString(root.name);
        if (name && normalizeHostToolName(name)) {
          return { toolName: name, args: root.input ?? root.arguments ?? {} };
        }
      }
      continue;
    }
    for (const block of content) {
      const entry = asRecord(block);
      if (!entry || asString(entry.type) !== "tool_use") {
        continue;
      }
      const name = asString(entry.name);
      if (!name || !normalizeHostToolName(name)) {
        continue;
      }
      return { toolName: name, args: entry.input ?? entry.arguments ?? {} };
    }
  }
  return null;
}

function extractClaudeTextSummary(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) {
      continue;
    }
    if (asString(root.type) === "result" && typeof root.result === "string") {
      texts.push(root.result);
    }
    const message = asRecord(root.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const entry = asRecord(block);
        if (entry && asString(entry.type) === "text" && typeof entry.text === "string") {
          texts.push(entry.text);
        }
      }
    }
  }
  if (texts.length > 0) {
    return sanitizeProviderText(texts.join("\n"));
  }
  return sanitizeProviderText(stdout);
}

async function defaultRunClaudeGoalTurn(
  input: ClaudeGoalTurnInput,
  timeoutMs: number
): Promise<ClaudeGoalTurnResult> {
  const args = [
    "--print",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    buildClaudeGoalAllowedTools()
  ];
  if (input.mcpConfigPath) {
    args.push("--strict-mcp-config", "--mcp-config", input.mcpConfigPath);
  }
  let childRef: ChildProcess | undefined;
  let captured = "";
  let killedForHostTool = false;

  const result = await runStreamingProcess({
    command: "claude",
    args,
    cwd: input.workspace,
    signal: input.signal,
    timeoutMs,
    onSpawn: (child) => {
      childRef = child;
    },
    onStdoutChunk: (chunk) => {
      captured += chunk;
      if (killedForHostTool) {
        return;
      }
      if (extractClaudeHostToolUse(captured) && childRef && !childRef.killed) {
        killedForHostTool = true;
        // Host tool captured — end the OS process so continuation is a new process.
        childRef.kill("SIGTERM");
      }
    },
    timeoutMessage: "Claude goal turn timed out."
  });

  return {
    ...result,
    ...(childRef?.pid !== undefined ? { pid: childRef.pid } : {})
  };
}

class ClaudeGoalTaskWorker implements TaskWorker {
  public constructor(
    private readonly options: {
      workspaceRoot: string;
      timeoutMs: number;
      mcpConfigPath?: string;
      runClaude?: ClaudeGoalTurnRunner;
      skipAutoGoalMcp?: boolean;
      goalHostMcpLaunch?: GoalHostMcpLaunch;
    }
  ) {}

  private resolveMcpConfigPath(): string | undefined {
    if (this.options.mcpConfigPath) {
      return this.options.mcpConfigPath;
    }
    if (this.options.runClaude || this.options.skipAutoGoalMcp) {
      return undefined;
    }
    const path = join(tmpdir(), `pairmesh-goal-claude-mcp-${process.pid}-${Date.now()}.json`);
    return writeClaudeGoalMcpConfigFile(path, this.options.goalHostMcpLaunch);
  }

  public async runTurn(envelope: TaskWorkerEnvelope): Promise<TaskWorkerTurnResult> {
    const prompt = buildGoalTurnPrompt(envelope);
    const mcpConfigPath = this.resolveMcpConfigPath();
    const runner = this.options.runClaude;
    let result: ClaudeGoalTurnResult;
    if (runner) {
      result = await runner({
        prompt,
        workspace: this.options.workspaceRoot,
        ...(mcpConfigPath ? { mcpConfigPath } : {})
      });
    } else {
      result = await defaultRunClaudeGoalTurn(
        {
          prompt,
          workspace: this.options.workspaceRoot,
          ...(mcpConfigPath ? { mcpConfigPath } : {})
        },
        this.options.timeoutMs
      );
    }

    const hostTool = extractClaudeHostToolUse(result.stdout);
    if (hostTool) {
      const parsed = parseHostToolCall(hostTool.toolName, hostTool.args);
      if (!parsed.ok) {
        return {
          kind: "failed",
          code: parsed.code,
          message: parsed.message
        };
      }
      return {
        kind: "host_request",
        toolName: parsed.toolName,
        args: parsed.args,
        checkpointSummary: sanitizeProviderText(
          `Requested ${parsed.toolName} via Claude goal turn.`
        )
      };
    }

    return {
      kind: "completed",
      summary: extractClaudeTextSummary(result.stdout || result.stderr)
    };
  }
}

function extractCursorHostToolName(params: unknown): string | undefined {
  const root = asRecord(params);
  const update = asRecord(root?.update) ?? root;
  if (!update) {
    return undefined;
  }
  const sessionUpdate = asString(update.sessionUpdate) ?? asString(root?.sessionUpdate);
  // Permission requests are not sessionUpdate tool_call events but carry MCP titles.
  const isPermissionShape = Boolean(root?.toolCall) && Array.isArray(root?.options);
  if (
    sessionUpdate &&
    sessionUpdate !== "tool_call" &&
    sessionUpdate !== "tool_call_update" &&
    !isPermissionShape
  ) {
    return undefined;
  }
  const toolCall = asRecord(update.toolCall) ?? asRecord(root?.toolCall);
  const candidates = [
    asString(update.name),
    asString(update.toolName),
    asString(update.title),
    asString(toolCall?.name),
    asString(toolCall?.title),
    asString(toolCall?.toolName)
  ];
  for (const candidate of candidates) {
    if (candidate && normalizeHostToolName(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseJsonObjectFromText(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function extractArgsFromToolCallContent(toolCall: Record<string, unknown> | undefined): unknown {
  if (!toolCall) {
    return undefined;
  }
  const content = toolCall.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const entry of content) {
    const record = asRecord(entry);
    const nested = asRecord(record?.content) ?? record;
    const text = asString(nested?.text);
    if (!text) {
      continue;
    }
    const parsed = parseJsonObjectFromText(text);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function extractCursorHostToolArgs(params: unknown): unknown {
  const root = asRecord(params);
  const update = asRecord(root?.update) ?? root;
  if (!update) {
    return {};
  }
  const toolCall = asRecord(update.toolCall) ?? asRecord(root?.toolCall);
  return (
    update.rawInput ??
    update.arguments ??
    update.input ??
    toolCall?.rawInput ??
    toolCall?.arguments ??
    toolCall?.input ??
    extractArgsFromToolCallContent(toolCall) ??
    {}
  );
}

const WRITE_PERMISSION_HINTS = [
  "write",
  "edit",
  "delete",
  "commit",
  "push",
  "shell",
  "terminal",
  "bash"
];

function isWriteLikePermission(title: string | undefined, optionIds: string[]): boolean {
  const haystack = `${title ?? ""} ${optionIds.join(" ")}`.toLowerCase();
  return WRITE_PERMISSION_HINTS.some((hint) => haystack.includes(hint));
}

function extractPermissionOptionIds(params: unknown): string[] {
  const root = asRecord(params);
  const options = root?.options ?? asRecord(root?.permission)?.options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((entry) => asString(asRecord(entry)?.optionId) ?? asString(asRecord(entry)?.id))
    .filter((id): id is string => Boolean(id));
}

function extractPermissionTitle(params: unknown): string | undefined {
  const root = asRecord(params);
  return (
    asString(root?.title) ??
    asString(asRecord(root?.toolCall)?.title) ??
    asString(asRecord(root?.permission)?.title)
  );
}

async function createDefaultCursorGoalAcpClient(input: {
  workspace: string;
  command: string;
  args: string[];
}): Promise<CursorAcpClient> {
  await assertCommandAvailable(input.command);
  return new AcpJsonRpcClient(input.command, input.args, input.workspace);
}

class CursorGoalTaskWorker implements TaskWorker {
  public constructor(
    private readonly options: {
      workspaceRoot: string;
      disableSessionReuse: boolean;
      createCursorAcpClient?: CursorGoalAcpFactory;
      mcpServers: CursorAcpMcpServerEntry[];
      cursorCommand: string;
      cursorArgs: string[];
      skipAutoGoalMcp?: boolean;
    }
  ) {}

  public async runTurn(envelope: TaskWorkerEnvelope): Promise<TaskWorkerTurnResult> {
    const prompt = buildGoalTurnPrompt(envelope);
    const factory =
      this.options.createCursorAcpClient ??
      ((input: { workspace: string }) =>
        createDefaultCursorGoalAcpClient({
          workspace: input.workspace,
          command: this.options.cursorCommand,
          args: this.options.cursorArgs
        }));

    const client = await factory({
      workspace: this.options.workspaceRoot
    });

    let hostRequest: TaskWorkerTurnResult | undefined;
    const textChunks: string[] = [];
    let sessionId: string | undefined;

    client.onNotification("session/update", (params) => {
      if (hostRequest) {
        return;
      }
      const toolName = extractCursorHostToolName(params);
      if (!toolName) {
        const root = asRecord(params);
        const update = asRecord(root?.update) ?? root;
        const chunk = asString(update?.text) ?? asString(asRecord(update?.content)?.text);
        if (chunk) {
          textChunks.push(chunk);
        }
        return;
      }
      const parsed = parseHostToolCall(toolName, extractCursorHostToolArgs(params));
      if (!parsed.ok) {
        hostRequest = {
          kind: "failed",
          code: parsed.code,
          message: parsed.message
        };
        return;
      }
      hostRequest = {
        kind: "host_request",
        toolName: parsed.toolName,
        args: parsed.args,
        checkpointSummary: sanitizeProviderText(
          `Requested ${parsed.toolName} via Cursor goal turn.`
        )
      };
    });

    client.onRequest("session/request_permission", (params) => {
      const optionIds = extractPermissionOptionIds(params);
      const title = extractPermissionTitle(params);
      if (isWriteLikePermission(title, optionIds)) {
        return { outcome: { outcome: "selected", optionId: "reject-once" } };
      }
      // Cursor ACP often surfaces MCP host tools only on permission requests
      // (tool_call notifications may have empty rawInput / generic "MCP: tool" title).
      if (!hostRequest) {
        const toolName = extractCursorHostToolName(params) ?? title;
        if (toolName && normalizeHostToolName(toolName)) {
          const parsed = parseHostToolCall(toolName, extractCursorHostToolArgs(params));
          if (parsed.ok) {
            hostRequest = {
              kind: "host_request",
              toolName: parsed.toolName,
              args: parsed.args,
              checkpointSummary: sanitizeProviderText(
                `Requested ${parsed.toolName} via Cursor goal turn.`
              )
            };
          } else {
            hostRequest = {
              kind: "failed",
              code: parsed.code,
              message: parsed.message
            };
          }
        }
      }
      // Allow read-only / MCP host tool permissions once.
      const allow = optionIds.find((id) => /allow/i.test(id)) ?? optionIds[0] ?? "allow-once";
      return { outcome: { outcome: "selected", optionId: allow } };
    });

    client.onRequest("cursor/ask_question", () => ({
      outcome: { outcome: "skipped", reason: "PairMesh goal mode runs unattended." }
    }));

    client.onRequest("cursor/create_plan", () => ({
      outcome: { outcome: "rejected", reason: "PairMesh goal mode does not create plans." }
    }));

    try {
      // Goal mode must never session/load — always session/new when reuse disabled.
      if (!this.options.disableSessionReuse) {
        throw createPairMeshError({
          code: "pairmesh.provider_goal_tools_unavailable",
          message: "Cursor goal mode requires disableCursorSessionReuse: true."
        });
      }

      const liveAcp = this.options.createCursorAcpClient === undefined;
      if (liveAcp) {
        await client.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false
          },
          clientInfo: { name: "pairmesh-goal-acp", version: "0.1.0" }
        });
        try {
          await client.request("authenticate", { methodId: "cursor_login" });
        } catch (error) {
          throw createPairMeshError({
            code: "pairmesh.provider_goal_tools_unavailable",
            message: "Cursor CLI is not authenticated for goal mode. Run `agent login` first.",
            details: {
              reason: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }

      const sessionResult = (await client.request("session/new", {
        cwd: this.options.workspaceRoot,
        mcpServers: this.options.mcpServers
      })) as { sessionId?: string };
      sessionId = sessionResult.sessionId;
      if (!sessionId) {
        return {
          kind: "failed",
          code: "pairmesh.provider_goal_tools_unavailable",
          message: "Cursor ACP session/new did not return a session id."
        };
      }

      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }]
      });

      if (hostRequest) {
        if (sessionId) {
          try {
            await client.request("session/cancel", { sessionId });
          } catch {
            // ignore cancel failures after host tool capture
          }
        }
        return hostRequest;
      }

      return {
        kind: "completed",
        summary: sanitizeProviderText(textChunks.join("") || "Cursor goal turn completed.")
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

class GeminiGoalTaskWorker implements TaskWorker {
  public constructor(
    private readonly options: {
      workspaceRoot: string;
      timeoutMs: number;
      runGemini?: GeminiGoalTurnRunner;
      skipAutoGoalMcp?: boolean;
      goalHostMcpLaunch?: GoalHostMcpLaunch;
      /** Extra CLI args (e.g. --allowed-mcp-server-names). */
      geminiExtraArgs?: string[];
    }
  ) {}

  public async runTurn(envelope: TaskWorkerEnvelope): Promise<TaskWorkerTurnResult> {
    const prompt = buildGoalTurnPrompt(envelope);
    if (this.options.runGemini) {
      return this.options.runGemini({
        prompt,
        workspace: this.options.workspaceRoot
      });
    }
    if (this.options.skipAutoGoalMcp) {
      return {
        kind: "failed",
        code: "pairmesh.provider_goal_tools_unavailable",
        message: "Gemini goal mode requires live MCP provisioning or an injected runGemini seam."
      };
    }

    const provision = await provisionGeminiGoalMcp({
      workspaceRoot: this.options.workspaceRoot,
      ...(this.options.goalHostMcpLaunch ? { launch: this.options.goalHostMcpLaunch } : {})
    });

    try {
      const model = process.env.PAIRMESH_GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
      const args = [
        "--model",
        model,
        "--prompt",
        prompt,
        "--output-format",
        "stream-json",
        // Headless non-interactive already denies shell/write. Plan mode
        // blocks non-readOnly MCP tools — use default + MCP trust instead.
        // Never yolo.
        "--approval-mode",
        "default",
        // Session trust for disposable/untrusted folders so MCP connects.
        "--skip-trust",
        "--allowed-mcp-server-names",
        PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME,
        ...(this.options.geminiExtraArgs ?? [])
      ];

      let childRef: ChildProcess | undefined;
      let captured = "";
      let killedForHostTool = false;

      // Ensure Gemini's #!/usr/bin/env node resolves to the same Node that
      // launched Aroko (Gemini CLI requires Node >=20).
      const geminiEnv = {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`
      };

      const result = await runStreamingProcess({
        command: "gemini",
        args,
        cwd: this.options.workspaceRoot,
        timeoutMs: this.options.timeoutMs,
        env: geminiEnv,
        onSpawn: (child) => {
          childRef = child;
        },
        onStdoutChunk: (chunk) => {
          captured += chunk;
          if (killedForHostTool) {
            return;
          }
          if (extractGeminiHostToolUse(captured) && childRef && !childRef.killed) {
            killedForHostTool = true;
            childRef.kill("SIGTERM");
          }
        },
        timeoutMessage: "Gemini goal turn timed out."
      });
      void childRef;

      const hostTool = extractGeminiHostToolUse(result.stdout);
      if (hostTool) {
        const parsed = parseHostToolCall(hostTool.toolName, hostTool.args);
        if (!parsed.ok) {
          return {
            kind: "failed",
            code: parsed.code,
            message: parsed.message
          };
        }
        return {
          kind: "host_request",
          toolName: parsed.toolName,
          args: parsed.args,
          checkpointSummary: sanitizeProviderText(
            `Requested ${parsed.toolName} via Gemini goal turn.`
          )
        };
      }

      // If Gemini ran but never invoked a host tool, treat as tools-unavailable
      // when stdout shows MCP/tool discovery failure patterns; otherwise completed.
      const combined = `${result.stdout}\n${result.stderr}`;
      if (
        /mcp.*(unavailable|failed|error|not found)/i.test(combined) ||
        /no mcp servers/i.test(combined)
      ) {
        return {
          kind: "failed",
          code: "pairmesh.provider_goal_tools_unavailable",
          message: "Gemini goal mode could not discover PairMesh host MCP tools."
        };
      }

      return {
        kind: "completed",
        summary: extractGeminiTextSummary(result.stdout || result.stderr)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "failed",
        code: "pairmesh.provider_goal_tools_unavailable",
        message: `Gemini goal MCP turn failed: ${sanitizeProviderText(message)}`
      };
    } finally {
      await restoreGeminiGoalMcp({
        workspaceRoot: this.options.workspaceRoot,
        provision
      });
    }
  }
}

/**
 * Scan Gemini stream-json NDJSON for the first PairMesh host request tool_use.
 * Gemini emits { type: "tool_use", tool_name, parameters }.
 */
export function extractGeminiHostToolUse(
  stdout: string
): { toolName: string; args: unknown } | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) {
      continue;
    }
    if (asString(root.type) !== "tool_use") {
      continue;
    }
    const name = asString(root.tool_name) ?? asString(root.name) ?? asString(root.toolName);
    if (!name || !normalizeHostToolName(name)) {
      continue;
    }
    return {
      toolName: name,
      args: root.parameters ?? root.input ?? root.arguments ?? {}
    };
  }
  return null;
}

function extractGeminiTextSummary(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) {
      continue;
    }
    if (asString(root.type) === "message" && asString(root.role) === "assistant") {
      const content = asString(root.content);
      if (content) {
        texts.push(content);
      }
    }
    if (asString(root.type) === "result" && typeof root.response === "string") {
      texts.push(root.response);
    }
  }
  if (texts.length > 0) {
    return sanitizeProviderText(texts.join("\n"));
  }
  return sanitizeProviderText(stdout);
}

/**
 * Factory for R5-6/R5-7G goal-mode TaskWorkers.
 * Fake / Claude / Cursor / Gemini use structured host tools (no text/regex emulation).
 */
export function createGoalTaskWorker(options: GoalTaskWorkerOptions): TaskWorker {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const skipAutoGoalMcp =
    options.skipAutoGoalMcp === true ||
    options.runClaude !== undefined ||
    options.createCursorAcpClient !== undefined ||
    options.runGemini !== undefined;

  switch (options.providerId) {
    case "fake":
      return (
        options.fakeWorker ??
        new FakeTaskWorker({
          instanceId: "goal-fake",
          script: [{ kind: "completed", summary: "Fake goal worker completed with no script." }]
        })
      );
    case "claude-code":
      return new ClaudeGoalTaskWorker({
        workspaceRoot: options.workspaceRoot,
        timeoutMs,
        skipAutoGoalMcp,
        ...(options.claudeMcpConfigPath ? { mcpConfigPath: options.claudeMcpConfigPath } : {}),
        ...(options.goalHostMcpLaunch ? { goalHostMcpLaunch: options.goalHostMcpLaunch } : {}),
        ...(options.runClaude ? { runClaude: options.runClaude } : {})
      });
    case "cursor": {
      const mcpServers =
        options.cursorMcpServers ??
        (skipAutoGoalMcp ? [] : buildCursorGoalAcpMcpServers(options.goalHostMcpLaunch));
      return new CursorGoalTaskWorker({
        workspaceRoot: options.workspaceRoot,
        disableSessionReuse: options.disableCursorSessionReuse !== false,
        mcpServers,
        cursorCommand: options.cursorCommand ?? "agent",
        cursorArgs: options.cursorArgs ?? ["acp"],
        skipAutoGoalMcp,
        ...(options.createCursorAcpClient
          ? { createCursorAcpClient: options.createCursorAcpClient }
          : {})
      });
    }
    case "gemini-cli":
      return new GeminiGoalTaskWorker({
        workspaceRoot: options.workspaceRoot,
        timeoutMs,
        skipAutoGoalMcp,
        ...(options.goalHostMcpLaunch ? { goalHostMcpLaunch: options.goalHostMcpLaunch } : {}),
        ...(options.runGemini ? { runGemini: options.runGemini } : {})
      });
    default: {
      const _exhaustive: never = options.providerId;
      throw createPairMeshError({
        code: "pairmesh.provider_goal_tools_unavailable",
        message: `Unknown goal provider: ${String(_exhaustive)}`
      });
    }
  }
}

export { PAIRMESH_GOAL_HOST_TOOLS };
