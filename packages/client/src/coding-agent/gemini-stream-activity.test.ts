import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { filterProgressEventsForViewer } from "@pairmesh/protocol";
import { mapProviderActivityToProgressEvent } from "../action/provider-activity.js";
import { dedupeGeminiActivityEvents, parseGeminiStreamJson } from "./gemini-stream-activity.js";
import { GeminiCliAdapter } from "./gemini-cli-adapter.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";

const workspace = join(process.cwd(), "fixtures", "propose-payment-service");

/**
 * NDJSON fixture matching @google/gemini-cli 0.56.x StreamJsonFormatter emits:
 * init / tool_use / tool_result / message / result
 */
function richGeminiNdjson(): string {
  const lines = [
    {
      type: "init",
      timestamp: "2026-08-27T18:00:00.000Z",
      session_id: "sess-gemini-1",
      model: "gemini-2.5-pro"
    },
    {
      type: "message",
      timestamp: "2026-08-27T18:00:00.100Z",
      role: "user",
      content: "read and search"
    },
    {
      type: "tool_use",
      timestamp: "2026-08-27T18:00:01.000Z",
      tool_name: "read_file",
      tool_id: "call_read_1",
      parameters: { file_path: join(workspace, "src", "retry.ts") }
    },
    {
      type: "tool_result",
      timestamp: "2026-08-27T18:00:01.500Z",
      tool_id: "call_read_1",
      status: "success",
      output: "export function retryRecord() { /* raw stdout never mapped */ }"
    },
    {
      type: "tool_use",
      timestamp: "2026-08-27T18:00:02.000Z",
      tool_name: "grep_search",
      tool_id: "call_grep_1",
      parameters: { pattern: "retryRecord.reference" }
    },
    {
      type: "tool_result",
      timestamp: "2026-08-27T18:00:02.500Z",
      tool_id: "call_grep_1",
      status: "success",
      output: "src/retry.ts:12: retryRecord.reference"
    },
    {
      type: "message",
      timestamp: "2026-08-27T18:00:03.000Z",
      role: "assistant",
      content: "Found the retry reference handling.",
      delta: true
    },
    {
      type: "result",
      timestamp: "2026-08-27T18:00:03.500Z",
      status: "success",
      stats: { total_tokens: 10, duration_ms: 3500, tool_calls: 2 }
    }
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("Stage 17 Prompt 7 — Gemini stream-json activity", () => {
  it("maps init/read_file/grep_search into canonical activity kinds", () => {
    const parsed = parseGeminiStreamJson({
      stdout: richGeminiNdjson(),
      workspace,
      requestId: "req_g1"
    });

    expect(parsed.hasRichToolActivity).toBe(true);
    expect(parsed.responseText).toContain("Found the retry reference");
    expect(parsed.isError).toBe(false);

    const kinds = parsed.activity.map((e) => e.activityKind);
    expect(kinds).toEqual([
      "worker.started",
      "file.read",
      "search.started",
      "search.completed",
      "provider.message"
    ]);

    const read = parsed.activity.find((e) => e.activityKind === "file.read");
    expect(read?.safeMetadata?.relativePath).toBe("src/retry.ts");
    expect(JSON.stringify(parsed.activity)).not.toContain("raw stdout");
    expect(JSON.stringify(parsed.activity)).not.toContain(join(workspace, "src"));

    const search = parsed.activity.find((e) => e.activityKind === "search.started");
    expect(search?.safeMetadata?.query).toBe("retryRecord.reference");
  });

  it("dedupes by providerEventId and forces owner_only on file/search via ProgressEvent map", () => {
    const parsed = parseGeminiStreamJson({
      stdout: richGeminiNdjson(),
      workspace,
      requestId: "req_g2"
    });
    const once = dedupeGeminiActivityEvents([...parsed.activity, ...parsed.activity]);
    expect(once).toHaveLength(parsed.activity.length);

    const progress = once.map((event) =>
      mapProviderActivityToProgressEvent({
        actionId: "act_g",
        event,
        timestamp: "2026-08-27T18:00:00.000Z"
      })
    );
    const owner = filterProgressEventsForViewer(progress, "owner");
    const requester = filterProgressEventsForViewer(progress, "requester");
    expect(owner.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(requester.some((e) => e.activityKind === "file.read")).toBe(false);
    expect(requester.every((e) => e.visibility === "requester_safe")).toBe(true);
    expect(JSON.stringify(requester)).not.toContain("src/retry");
  });

  it("falls back coarsely for legacy single JSON without tool events", () => {
    const parsed = parseGeminiStreamJson({
      stdout: JSON.stringify({ response: "Coarse only." }),
      workspace,
      requestId: "req_coarse"
    });
    expect(parsed.responseText).toBe("Coarse only.");
    expect(parsed.hasRichToolActivity).toBe(false);
    expect(parsed.activity).toEqual([]);
  });

  it("ignores write/shell tools; maps assistant message to provider.message without tool output", () => {
    const stdout = [
      JSON.stringify({ type: "init", session_id: "s", model: "m" }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "write_file",
        tool_id: "w1",
        parameters: { file_path: "src/x.ts", content: "secret" }
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "run_shell_command",
        tool_id: "sh1",
        parameters: { command: "cat .env" }
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "I should not become an activity kind."
      }),
      JSON.stringify({ type: "result", status: "success", stats: {} })
    ].join("\n");

    const parsed = parseGeminiStreamJson({
      stdout,
      workspace,
      requestId: "req_safe"
    });
    expect(parsed.activity.map((e) => e.activityKind)).toEqual([
      "worker.started",
      "provider.message"
    ]);
    expect(parsed.responseText).toContain("should not become");
    expect(JSON.stringify(parsed.activity)).not.toContain(".env");
    expect(JSON.stringify(parsed.activity)).not.toContain("secret");
  });

  it("adapter emits rich onProviderActivity on inspect with stream-json args", async () => {
    const events: ProviderActivityEvent[] = [];
    const adapter = new GeminiCliAdapter({
      workspace,
      timeoutMs: 5_000,
      runProcess: async (input) => {
        expect(input.args).toContain("stream-json");
        expect(input.args).toContain("plan");
        return { exitCode: 0, stdout: richGeminiNdjson(), stderr: "" };
      }
    });

    const result = await adapter.inspect(
      { requestId: "req_emit", question: "Check retry" },
      {
        onProviderActivity: (event) => {
          events.push(event);
        }
      }
    );

    expect(result.summary).toContain("retry reference");
    expect(events.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(events.some((e) => e.activityKind === "search.started")).toBe(true);
    expect(events.some((e) => e.activityKind === "worker.completed")).toBe(true);
  });
});

describe("Stage 19 Prompt 5 — Gemini narration + CoT boundary", () => {
  it("never surfaces thinking records and preserves final answer", () => {
    const stdout = [
      JSON.stringify({ type: "init", session_id: "s", model: "m" }),
      JSON.stringify({
        type: "thinking",
        content: "PRIVATE_COT_MUST_NEVER_APPEAR"
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Safe narration about ProgressEvent."
      }),
      JSON.stringify({ type: "result", status: "success" })
    ].join("\n");

    const parsed = parseGeminiStreamJson({
      stdout,
      workspace,
      requestId: "req_p5_cot"
    });
    expect(parsed.responseText).toContain("Safe narration");
    expect(parsed.activity.some((e) => e.activityKind === "provider.message")).toBe(true);
    expect(JSON.stringify(parsed.activity)).not.toContain("PRIVATE_COT_MUST_NEVER_APPEAR");
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE_COT_MUST_NEVER_APPEAR");
  });

  it("uses distinct lifecycle ids for search start/complete", () => {
    const stdout = [
      JSON.stringify({ type: "init", session_id: "s", model: "m" }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "grep_search",
        tool_id: "call_g",
        parameters: { pattern: "x" }
      }),
      JSON.stringify({
        type: "tool_result",
        tool_id: "call_g",
        status: "success",
        output: "hits"
      }),
      JSON.stringify({ type: "message", role: "assistant", content: "Done." }),
      JSON.stringify({ type: "result", status: "success" })
    ].join("\n");
    const parsed = parseGeminiStreamJson({
      stdout,
      workspace,
      requestId: "req_p5_ids"
    });
    const started = parsed.activity.find((e) => e.activityKind === "search.started");
    const completed = parsed.activity.find((e) => e.activityKind === "search.completed");
    expect(started?.providerEventId).toContain("started");
    expect(completed?.providerEventId).toContain("completed");
    expect(started?.providerEventId).not.toBe(completed?.providerEventId);
  });
});
