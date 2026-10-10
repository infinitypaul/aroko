import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  dedupeClaudeActivityEvents,
  parseClaudeStreamJson,
  toWorkspaceRelativeToolPath
} from "./claude-stream-activity.js";

const workspace = join(process.cwd(), "fixtures", "propose-payment-service");

function ndjson(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

/** Fixture shapes aligned with Claude Agent SDK SDKMessage + Read/Grep/Glob inputs (v2.1.x). */
function richProposeStream(workspaceRoot: string): string {
  const retryAbs = join(workspaceRoot, "src", "retry.ts");
  const paymentAbs = join(workspaceRoot, "src", "payment.ts");
  const proposal = [
    "<<<PAIRMESH_PROPOSAL_PROVIDER_BEGIN>>>",
    JSON.stringify({
      version: "pairmesh.proposal-provider.v1",
      summary: "Preserve original payment reference.",
      files: [
        {
          path: "src/retry.ts",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new"
        }
      ]
    }),
    "<<<PAIRMESH_PROPOSAL_PROVIDER_END>>>"
  ].join("\n");

  return ndjson([
    {
      type: "system",
      subtype: "init",
      uuid: "u-init",
      session_id: "sess_probe",
      model: "claude-sonnet"
    },
    {
      type: "assistant",
      uuid: "u-a1",
      session_id: "sess_probe",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_read1",
            name: "Read",
            input: { file_path: retryAbs }
          }
        ],
        model: "claude-sonnet",
        stop_reason: "tool_use"
      }
    },
    {
      type: "user",
      uuid: "u-u1",
      session_id: "sess_probe",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read1",
            content: "file contents"
          }
        ]
      }
    },
    {
      type: "assistant",
      uuid: "u-a2",
      session_id: "sess_probe",
      parent_tool_use_id: null,
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_grep1",
            name: "Grep",
            input: { pattern: "retryRecord.reference", path: workspaceRoot }
          }
        ],
        model: "claude-sonnet",
        stop_reason: "tool_use"
      }
    },
    {
      type: "user",
      uuid: "u-u2",
      session_id: "sess_probe",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_grep1", content: "matches" }]
      }
    },
    {
      type: "assistant",
      uuid: "u-a3",
      session_id: "sess_probe",
      parent_tool_use_id: null,
      message: {
        id: "msg_3",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_read2",
            name: "Read",
            input: { file_path: paymentAbs }
          },
          {
            type: "thinking",
            thinking: "SECRET_CHAIN_OF_THOUGHT_MUST_NOT_LEAK"
          }
        ],
        model: "claude-sonnet",
        stop_reason: "tool_use"
      }
    },
    {
      type: "user",
      uuid: "u-u3",
      session_id: "sess_probe",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_read2", content: "payment file" }]
      }
    },
    {
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "partial" } }
    },
    { not: "a valid claude record", garbage: true },
    "this line is not json",
    {
      type: "result",
      subtype: "success",
      uuid: "u-result",
      session_id: "sess_probe",
      is_error: false,
      result: proposal,
      duration_ms: 12,
      duration_api_ms: 10,
      num_turns: 2,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: []
    }
  ]);
}

describe("Stage 17 Prompt 3 — Claude stream-json activity", () => {
  it("maps Read/Grep lifecycle into owner_only rich kinds with relative paths", () => {
    const parsed = parseClaudeStreamJson({
      stdout: richProposeStream(workspace),
      workspace,
      requestId: "req_stream_1"
    });

    expect(parsed.hasRichToolActivity).toBe(true);
    expect(parsed.responseText).toContain("pairmesh.proposal-provider.v1");
    expect(parsed.isError).toBe(false);

    const kinds = parsed.activity.map((event) => event.activityKind);
    expect(kinds).toEqual([
      "worker.started",
      "file.read",
      "search.started",
      "search.completed",
      "file.read"
    ]);

    const reads = parsed.activity.filter((event) => event.activityKind === "file.read");
    expect(reads.map((event) => event.safeMetadata?.relativePath)).toEqual([
      "src/retry.ts",
      "src/payment.ts"
    ]);
    expect(
      reads.every((event) => event.visibility === undefined || event.visibility === "owner_only")
    ).toBe(true);

    const search = parsed.activity.find((event) => event.activityKind === "search.started");
    expect(search?.safeMetadata?.query).toBe("retryRecord.reference");

    const serialized = JSON.stringify(parsed.activity);
    expect(serialized).not.toContain("SECRET_CHAIN_OF_THOUGHT");
    expect(serialized).not.toContain("thinking");
    expect(serialized).not.toMatch(/\/Users\//);
  });

  it("dedupes duplicate providerEventId values", () => {
    const parsed = parseClaudeStreamJson({
      stdout: richProposeStream(workspace),
      workspace,
      requestId: "req_dup"
    });
    const doubled = dedupeClaudeActivityEvents([...parsed.activity, ...parsed.activity]);
    expect(doubled).toHaveLength(parsed.activity.length);
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(toWorkspaceRelativeToolPath(workspace, "/etc/passwd")).toBeUndefined();
    expect(toWorkspaceRelativeToolPath(workspace, join(workspace, "src", "retry.ts"))).toBe(
      "src/retry.ts"
    );
  });

  it("degrades safely on malformed / unknown stream records and legacy json", () => {
    const malformed = parseClaudeStreamJson({
      stdout: '{not-json}\n{"type":"unknown_event"}\n',
      workspace,
      requestId: "req_bad"
    });
    expect(malformed.activity).toEqual([]);
    expect(malformed.hasRichToolActivity).toBe(false);

    const legacy = parseClaudeStreamJson({
      stdout: JSON.stringify({ result: "hello", is_error: false, session_id: "s1" }),
      workspace,
      requestId: "req_legacy"
    });
    expect(legacy.responseText).toBe("hello");
    expect(legacy.hasRichToolActivity).toBe(false);
    expect(legacy.activity).toEqual([]);
  });

  it("maps error result subtype without fabricating tool activity", () => {
    const parsed = parseClaudeStreamJson({
      stdout: ndjson([
        {
          type: "result",
          subtype: "error_during_execution",
          uuid: "u-err",
          session_id: "s",
          is_error: true,
          errors: ["boom"],
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 0,
          stop_reason: null,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: []
        }
      ]),
      workspace,
      requestId: "req_err"
    });
    expect(parsed.isError).toBe(true);
    expect(parsed.errorMessage).toBe("boom");
    expect(parsed.hasRichToolActivity).toBe(false);
  });
});

describe("Stage 19 Prompt 5 — Claude narration + CoT boundary", () => {
  it("aggregates assistant text into provider.message without altering result text", () => {
    const stdout = ndjson([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll inspect " },
            { type: "text", text: "the payment flow." },
            {
              type: "tool_use",
              id: "toolu_r1",
              name: "Read",
              input: { file_path: join(workspace, "src", "payment.ts") }
            },
            {
              type: "thinking",
              thinking: "PRIVATE_COT_MUST_NEVER_APPEAR"
            }
          ]
        }
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_r1", content: "file" }]
        }
      },
      {
        type: "result",
        subtype: "success",
        result: "AUTHORITATIVE_FINAL_ANSWER_ONLY",
        is_error: false
      }
    ]);

    const parsed = parseClaudeStreamJson({
      stdout,
      workspace,
      requestId: "req_p5_narr"
    });

    expect(parsed.responseText).toBe("AUTHORITATIVE_FINAL_ANSWER_ONLY");
    expect(parsed.activity.some((e) => e.activityKind === "provider.message")).toBe(true);
    expect(parsed.activity.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(parsed.activity.every((e) => e.activityKind !== "tool.completed")).toBe(true);
    const msg = parsed.activity.find((e) => e.activityKind === "provider.message");
    expect(msg?.message).toContain("payment flow");
    expect(JSON.stringify(parsed.activity)).not.toContain("PRIVATE_COT_MUST_NEVER_APPEAR");
  });

  it("bounds hundreds of tiny narration chunks", () => {
    const chunks = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: i % 20 === 19 ? `word${i}. ` : `w${i} ` }] }
      })
    );
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      ...chunks,
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        is_error: false
      })
    ].join("\n");

    const parsed = parseClaudeStreamJson({
      stdout,
      workspace,
      requestId: "req_p5_agg"
    });
    const messages = parsed.activity.filter((e) => e.activityKind === "provider.message");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(40);
    expect(parsed.responseText).toBe("done");
  });

  it("uses distinct lifecycle providerEventIds for search start/complete", () => {
    const stdout = ndjson([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_g1",
              name: "Grep",
              input: { pattern: "ProgressEvent" }
            }
          ]
        }
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_g1", content: "hits" }]
        }
      },
      { type: "result", subtype: "success", result: "ok", is_error: false }
    ]);
    const parsed = parseClaudeStreamJson({
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
