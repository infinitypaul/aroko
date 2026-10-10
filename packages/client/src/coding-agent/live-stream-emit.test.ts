import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { ClaudeStreamSession } from "./claude-stream-activity.js";
import { GeminiCliAdapter } from "./gemini-cli-adapter.js";
import { GeminiStreamSession } from "./gemini-stream-activity.js";
import { NdjsonLineBuffer, NdjsonLineTooLongError } from "./ndjson-line-buffer.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";
import { runStreamingProcess } from "./streaming-process.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

function claudeInitLine(): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1" });
}

function claudeReadLine(id: string, path: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }]
    }
  });
}

function claudeResultLine(text: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text });
}

function geminiInitLine(): string {
  return JSON.stringify({ type: "init", session_id: "g1", model: "gemini-test" });
}

function geminiReadLine(id: string, path: string): string {
  return JSON.stringify({
    type: "tool_use",
    tool_name: "read_file",
    tool_id: id,
    parameters: { file_path: path }
  });
}

function geminiMessage(text: string): string {
  return JSON.stringify({ type: "message", role: "assistant", content: text });
}

function geminiResultOk(): string {
  return JSON.stringify({ type: "result", status: "ok" });
}

describe("Stage 19 Prompt 3 — NdjsonLineBuffer", () => {
  it("handles fragmented records and multiple lines per chunk", () => {
    const buf = new NdjsonLineBuffer();
    expect(buf.push('{"a":')).toEqual([]);
    expect(buf.push('1}\n{"b":2}\n{"c":')).toEqual(['{"a":1}', '{"b":2}']);
    expect(buf.push("3}\n")).toEqual(['{"c":3}']);
    expect(buf.flush()).toBeUndefined();
  });

  it("returns trailing fragment on flush", () => {
    const buf = new NdjsonLineBuffer();
    buf.push('{"partial":true');
    expect(buf.flush()).toBe('{"partial":true');
  });

  it("rejects oversized lines without newline", () => {
    const buf = new NdjsonLineBuffer({ maxLineBytes: 32 });
    expect(() => buf.push("x".repeat(40))).toThrow(NdjsonLineTooLongError);
  });
});

describe("Stage 19 Prompt 3 — Claude live stream", () => {
  it("emits activity before process completion and does not double-emit", async () => {
    const events: ProviderActivityEvent[] = [];
    let sawActivityBeforeExit = false;
    let processStillRunning = true;

    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 10_000,
      runProcess: async (input) => {
        const lines = [
          claudeInitLine(),
          claudeReadLine("tu_1", join(fixtureWorkspace, "src/retry.ts")),
          claudeResultLine("Summary: retry path is in src/retry.ts")
        ];
        // Fragment first record across chunks, then delay before exit.
        const first = `${lines[0]}\n`;
        input.onStdoutChunk?.(first.slice(0, 10));
        await new Promise((r) => setTimeout(r, 20));
        input.onStdoutChunk?.(first.slice(10));
        await new Promise((r) => setTimeout(r, 20));
        input.onStdoutChunk?.(`${lines[1]}\n${lines[2]}\n`);
        if (events.length > 0) {
          sawActivityBeforeExit = true;
        }
        expect(processStillRunning).toBe(true);
        await new Promise((r) => setTimeout(r, 40));
        processStillRunning = false;
        return {
          exitCode: 0,
          stdout: `${lines.join("\n")}\n`,
          stderr: ""
        };
      }
    });

    const result = await adapter.inspect(
      {
        requestId: "req_live_claude",
        question: "Where is retry rebuild?"
      },
      {
        onProviderActivity: (event) => {
          events.push(event);
        }
      }
    );

    expect(sawActivityBeforeExit).toBe(true);
    expect(events.some((e) => e.activityKind === "worker.started")).toBe(true);
    expect(events.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(result.summary.length).toBeGreaterThan(0);

    const ids = events.map((e) => e.providerEventId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not map thinking/stream_event into activity", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new ClaudeStreamSession({
      workspace: fixtureWorkspace,
      requestId: "req_cot",
      onActivity: (e) => events.push(e)
    });
    session.pushStdout(
      `${JSON.stringify({ type: "thinking", thinking: "secret" })}\n` +
        `${JSON.stringify({ type: "stream_event", event: {} })}\n` +
        `${claudeInitLine()}\n`
    );
    session.finalize();
    expect(events.every((e) => e.activityKind !== undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/secret|thinking/i);
    expect(events.some((e) => e.activityKind === "worker.started")).toBe(true);
  });

  it("fences late activity after cancel", async () => {
    const events: ProviderActivityEvent[] = [];
    const controller = new AbortController();
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 10_000,
      runProcess: async (input) => {
        input.onStdoutChunk?.(`${claudeInitLine()}\n`);
        await new Promise((r) => setTimeout(r, 10));
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        // Late chunk after abort — session should be fenced by adapter abort listener.
        input.onStdoutChunk?.(
          `${claudeReadLine("tu_late", join(fixtureWorkspace, "src/retry.ts"))}\n`
        );
        throw Object.assign(new Error("Inspection was cancelled."), {
          code: "agent_cancelled"
        });
      }
    });

    await expect(
      adapter.inspect(
        { requestId: "req_cancel_claude", question: "x" },
        {
          signal: controller.signal,
          onProviderActivity: (e) => events.push(e)
        }
      )
    ).rejects.toMatchObject({ code: "agent_cancelled" });

    expect(events.some((e) => e.activityKind === "file.read")).toBe(false);
  });
});

describe("Stage 19 Prompt 3 — Gemini live stream", () => {
  it("emits activity before process completion and preserves final text", async () => {
    const events: ProviderActivityEvent[] = [];
    let sawBeforeExit = false;

    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 10_000,
      runProcess: async (input) => {
        const path = join(fixtureWorkspace, "src/payment.ts");
        input.onStdoutChunk?.(`${geminiInitLine()}\n`);
        await new Promise((r) => setTimeout(r, 15));
        input.onStdoutChunk?.(`${geminiReadLine("t1", path)}\n`);
        if (events.length > 0) {
          sawBeforeExit = true;
        }
        await new Promise((r) => setTimeout(r, 30));
        input.onStdoutChunk?.(
          `${geminiMessage("Payment mapping is in src/payment.ts")}\n${geminiResultOk()}\n`
        );
        return {
          exitCode: 0,
          stdout: [
            geminiInitLine(),
            geminiReadLine("t1", path),
            geminiMessage("Payment mapping is in src/payment.ts"),
            geminiResultOk()
          ].join("\n"),
          stderr: ""
        };
      }
    });

    const result = await adapter.inspect(
      {
        requestId: "req_live_gemini",
        question: "Where is paymentReference?"
      },
      {
        onProviderActivity: (e) => events.push(e)
      }
    );

    expect(sawBeforeExit).toBe(true);
    expect(events.some((e) => e.activityKind === "worker.started")).toBe(true);
    expect(events.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(result.summary).toContain("payment");
    expect(JSON.stringify(events)).not.toMatch(/stdout|chainOfThought|thinking/i);
    const ids = events.map((e) => e.providerEventId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("aggregates assistant messages into provider.message while preserving final text", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new GeminiStreamSession({
      workspace: fixtureWorkspace,
      requestId: "req_msg",
      onActivity: (e) => events.push(e)
    });
    session.pushStdout(
      `${geminiInitLine()}\n${geminiMessage("I will inspect quietly.")}\n${geminiResultOk()}\n`
    );
    const parsed = session.finalize();
    expect(events.some((e) => e.activityKind === "provider.message")).toBe(true);
    expect(events.find((e) => e.activityKind === "provider.message")?.message).toContain(
      "inspect quietly"
    );
    expect(parsed.responseText).toContain("inspect quietly");
  });
});

describe("Stage 19 Prompt 3 — streaming process fixture", () => {
  it("parses fragmented NDJSON from a real child process before exit", async () => {
    const script = `
      const lines = [
        ${JSON.stringify(claudeInitLine())},
        ${JSON.stringify(claudeReadLine("tu_p", "src/retry.ts"))},
        ${JSON.stringify(claudeResultLine("ok done"))}
      ];
      process.stdout.write(lines[0].slice(0, 8));
      setTimeout(() => {
        process.stdout.write(lines[0].slice(8) + "\\n" + lines[1] + "\\n");
        setTimeout(() => {
          process.stdout.write(lines[2] + "\\n");
          process.exit(0);
        }, 40);
      }, 40);
    `;

    const events: ProviderActivityEvent[] = [];
    const session = new ClaudeStreamSession({
      workspace: fixtureWorkspace,
      requestId: "req_proc",
      onActivity: (e) => events.push(e)
    });
    let activityBeforeClose = false;

    const result = await runStreamingProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: fixtureWorkspace,
      timeoutMs: 5_000,
      onStdoutChunk: (chunk) => {
        session.pushStdout(chunk);
        if (events.length > 0) {
          activityBeforeClose = true;
        }
      }
    });

    session.finalize();
    expect(result.exitCode).toBe(0);
    expect(activityBeforeClose).toBe(true);
    expect(events.some((e) => e.activityKind === "worker.started")).toBe(true);
  });
});
