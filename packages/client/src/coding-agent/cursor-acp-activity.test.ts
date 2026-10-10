import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CursorAcpActivitySession,
  classifyCursorSessionUpdate,
  extractSafeToolFieldsFromRawInput,
  isAgentThoughtChunk,
  parseCursorToolCall
} from "./cursor-acp-activity.js";
import { CursorAcpAdapter, type CursorAcpClient } from "./cursor-adapter.js";
import type { ProviderActivityEvent } from "./provider-visibility.js";
import { CODING_AGENT_OWNER_VISIBILITY } from "./provider-visibility.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

function sessionUpdate(update: Record<string, unknown>): { update: Record<string, unknown> } {
  return { update };
}

function messageChunk(text: string) {
  return sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text }
  });
}

function thoughtChunk(text: string) {
  return sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text }
  });
}

function toolCall(input: {
  id: string;
  kind: string;
  status?: string;
  title?: string;
  rawInput?: Record<string, unknown>;
}) {
  return sessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: input.id,
    kind: input.kind,
    status: input.status ?? "pending",
    ...(input.title ? { title: input.title } : {}),
    ...(input.rawInput ? { rawInput: input.rawInput } : { rawInput: {} })
  });
}

function toolUpdate(id: string, status: string) {
  return sessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status
  });
}

describe("Stage 19 Prompt 4 — Cursor ACP activity mapping", () => {
  it("maps search/read lifecycle without generic tool spam and aggregates messages", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_cursor_map",
      onActivity: (e) => events.push(e)
    });

    session.handleSessionUpdate(messageChunk("I'll inspect "));
    session.handleSessionUpdate(messageChunk("the payment flow."));
    session.handleSessionUpdate(
      toolCall({
        id: "search1",
        kind: "search",
        status: "pending",
        title: "Search payment",
        rawInput: { pattern: "ProgressEvent" }
      })
    );
    session.handleSessionUpdate(toolUpdate("search1", "in_progress"));
    session.handleSessionUpdate(toolUpdate("search1", "completed"));
    session.handleSessionUpdate(
      toolCall({
        id: "read1",
        kind: "read",
        status: "pending",
        rawInput: { path: "src/payment.ts" }
      })
    );
    session.handleSessionUpdate(toolUpdate("read1", "in_progress"));
    session.handleSessionUpdate(toolUpdate("read1", "completed"));
    session.handleSessionUpdate(thoughtChunk("PRIVATE_SENTINEL_DO_NOT_SURFACE"));
    session.handleSessionUpdate(messageChunk("The retry worker is relevant."));
    session.flushMessages();

    const kinds = events.map((e) => e.activityKind);
    expect(kinds).toContain("provider.message");
    expect(kinds).toContain("search.started");
    expect(kinds).toContain("search.completed");
    expect(kinds).toContain("file.read");
    expect(kinds.filter((k) => k === "tool.started")).toHaveLength(0);
    expect(kinds.filter((k) => k === "tool.in_progress")).toHaveLength(0);

    const searchStarted = events.find((e) => e.activityKind === "search.started");
    expect(searchStarted?.safeMetadata?.query).toBe("ProgressEvent");
    const fileRead = events.find((e) => e.activityKind === "file.read");
    expect(fileRead?.safeMetadata?.relativePath).toBe("src/payment.ts");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("PRIVATE_SENTINEL_DO_NOT_SURFACE");
    expect(session.thoughtChunkCount).toBe(1);

    const messages = events.filter((e) => e.activityKind === "provider.message");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeLessThan(10);
    expect(messages.some((m) => m.message?.includes("payment flow"))).toBe(true);
  });

  it("does not emit hundreds of provider.message events for tiny chunks", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_chunks",
      onActivity: (e) => events.push(e)
    });
    for (let i = 0; i < 415; i += 1) {
      session.handleSessionUpdate(messageChunk(i % 17 === 0 ? "word. " : "x"));
    }
    session.flushMessages();
    const messages = events.filter((e) => e.activityKind === "provider.message");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(80);
  });

  it("dedupes duplicate lifecycle transitions via providerEventId", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_dedupe",
      onActivity: (e) => events.push(e)
    });
    const start = toolCall({ id: "search1", kind: "search", status: "pending" });
    const mid = toolUpdate("search1", "in_progress");
    const done = toolUpdate("search1", "completed");
    for (const event of [start, mid, done, start, mid, done]) {
      session.handleSessionUpdate(event);
    }
    const kinds = events.map((e) => e.activityKind);
    expect(kinds.filter((k) => k === "search.started")).toHaveLength(1);
    expect(kinds.filter((k) => k === "search.completed")).toHaveLength(1);
  });

  it("rejects unsafe paths from rawInput and keeps event", () => {
    expect(
      extractSafeToolFieldsFromRawInput({ path: "/Users/paul/private/file.ts" }, fixtureWorkspace)
        .relativePath
    ).toBeUndefined();
    expect(
      extractSafeToolFieldsFromRawInput({ path: "../../secret.env" }, fixtureWorkspace).relativePath
    ).toBeUndefined();

    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_path",
      onActivity: (e) => events.push(e)
    });
    session.handleSessionUpdate(
      toolCall({
        id: "read_bad",
        kind: "read",
        status: "pending",
        rawInput: { path: "/Users/paul/private/file.ts" }
      })
    );
    expect(events.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("/Users/paul");
  });

  it("ignores unknown and malformed updates safely", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_unknown",
      onActivity: (e) => events.push(e)
    });
    expect(
      classifyCursorSessionUpdate(sessionUpdate({ sessionUpdate: "future_cursor_event_2099" }))
    ).toBe("unknown");
    session.handleSessionUpdate(sessionUpdate({ sessionUpdate: "future_cursor_event_2099" }));
    session.handleSessionUpdate(
      sessionUpdate({ sessionUpdate: "tool_call", kind: "search", status: "pending" })
    );
    expect(parseCursorToolCall(sessionUpdate({ sessionUpdate: "tool_call" }))).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("never reads thought content into activity", () => {
    expect(isAgentThoughtChunk(thoughtChunk("SECRET_REASONING"))).toBe(true);
    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_thought",
      onActivity: (e) => events.push(e)
    });
    session.handleSessionUpdate(thoughtChunk("SECRET_REASONING"));
    session.handleSessionUpdate(thoughtChunk("chainOfThought: leak"));
    expect(events).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("fences late updates after terminal", () => {
    const events: ProviderActivityEvent[] = [];
    const session = new CursorAcpActivitySession({
      workspace: fixtureWorkspace,
      requestId: "req_fence",
      onActivity: (e) => events.push(e)
    });
    session.handleSessionUpdate(toolCall({ id: "s1", kind: "search", status: "pending" }));
    session.fence();
    session.handleSessionUpdate(toolUpdate("s1", "completed"));
    session.handleSessionUpdate(messageChunk("late"));
    expect(events.map((e) => e.activityKind)).toEqual(["search.started"]);
  });
});

class FakeCursorAcpClient implements CursorAcpClient {
  private notificationHandler: ((params: unknown) => void | Promise<void>) | undefined;
  private readonly requestHandlers = new Map<
    string,
    (params: unknown, id: number) => unknown | Promise<unknown>
  >();
  public permissionCalls = 0;
  public closed = false;
  private promptResolve: (() => void) | undefined;
  private readonly script: Array<{ delayMs: number; params: unknown }>;
  private readonly finalAnswerParts: string[];

  public constructor(input: {
    script: Array<{ delayMs: number; params: unknown }>;
    finalAnswerParts: string[];
  }) {
    this.script = input.script;
    this.finalAnswerParts = input.finalAnswerParts;
  }

  public onNotification(method: string, handler: (params: unknown) => void | Promise<void>): void {
    if (method === "session/update") {
      this.notificationHandler = handler;
    }
  }

  public onRequest(
    method: string,
    handler: (params: unknown, id: number) => unknown | Promise<unknown>
  ): void {
    this.requestHandlers.set(method, handler);
  }

  public async request(method: string, params?: unknown): Promise<unknown> {
    if (method === "initialize" || method === "authenticate") {
      return {};
    }
    if (method === "session/new") {
      return { sessionId: "sess_fake_cursor" };
    }
    if (method === "session/cancel") {
      return {};
    }
    if (method === "session/prompt") {
      // Drive scripted notifications while prompt is "in flight".
      for (const step of this.script) {
        await new Promise((r) => setTimeout(r, step.delayMs));
        await this.notificationHandler?.(step.params);
      }
      // Resolve prompt after script — allow mid-flight observers to see events.
      await new Promise<void>((resolve) => {
        this.promptResolve = resolve;
        setTimeout(resolve, 40);
      });
      return { stopReason: "end_turn" };
    }
    if (method === "session/request_permission") {
      this.permissionCalls += 1;
      const handler = this.requestHandlers.get(method);
      return handler?.(params, 1);
    }
    return {};
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.promptResolve?.();
  }

  public getFinalAnswer(): string {
    return this.finalAnswerParts.join("");
  }
}

describe("Stage 19 Prompt 4 — CursorAcpAdapter live emit", () => {
  it("emits rich activity before prompt completion and preserves final answer", async () => {
    const events: ProviderActivityEvent[] = [];
    const coarse: string[] = [];
    let sawRichBeforeDone = false;

    const finalParts = [
      "I'll inspect the payment flow.",
      " ProgressEvent lives in packages/protocol."
    ];
    const fake = new FakeCursorAcpClient({
      finalAnswerParts: finalParts,
      script: [
        { delayMs: 5, params: messageChunk("I'll inspect ") },
        { delayMs: 5, params: messageChunk("the payment flow.") },
        {
          delayMs: 10,
          params: toolCall({
            id: "search1",
            kind: "search",
            status: "pending",
            rawInput: { pattern: "ProgressEvent" }
          })
        },
        { delayMs: 10, params: toolUpdate("search1", "in_progress") },
        { delayMs: 10, params: toolUpdate("search1", "completed") },
        {
          delayMs: 10,
          params: toolCall({
            id: "read1",
            kind: "read",
            status: "pending",
            rawInput: { path: "src/payment.ts" }
          })
        },
        { delayMs: 10, params: toolUpdate("read1", "completed") },
        {
          delayMs: 5,
          params: thoughtChunk("PRIVATE_SENTINEL_DO_NOT_SURFACE")
        },
        {
          delayMs: 5,
          params: messageChunk(" ProgressEvent lives in packages/protocol.")
        },
        {
          delayMs: 5,
          params: sessionUpdate({ sessionUpdate: "future_cursor_event_2099" })
        }
      ]
    });

    // Patch message accumulation: Fake drives notifications; final answer comes from chunks.
    const adapter = new CursorAcpAdapter({
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 10_000,
      createAcpClient: () => fake
    });

    const resultPromise = adapter.inspect(
      {
        requestId: "req_cursor_live",
        question: "Where is ProgressEvent defined?"
      },
      {
        onProviderActivity: (event) => {
          events.push(event);
          if (
            event.activityKind === "search.started" ||
            event.activityKind === "file.read" ||
            event.activityKind === "provider.message"
          ) {
            sawRichBeforeDone = true;
          }
        },
        onProgress: (event) => {
          if (event.phase === "inspecting") {
            coarse.push(event.message ?? event.phase);
          }
        }
      }
    );

    // Wait until rich events appear while still awaiting prompt.
    for (let i = 0; i < 40 && !sawRichBeforeDone; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const result = await resultPromise;
    expect(sawRichBeforeDone).toBe(true);
    expect(events.some((e) => e.activityKind === "search.started")).toBe(true);
    expect(events.some((e) => e.activityKind === "file.read")).toBe(true);
    expect(events.some((e) => e.activityKind === "worker.started")).toBe(true);
    expect(events.some((e) => e.activityKind === "worker.completed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL_DO_NOT_SURFACE");
    expect(result.summary).toContain("ProgressEvent");
    expect(result.summary).toContain("payment flow");
    // Coarse inspecting should not fire on every message chunk once rich activity exists.
    expect(coarse.length).toBeLessThan(20);
  });

  it("still rejects write-like permissions", async () => {
    let permissionHandler:
      ((params: unknown, id: number) => unknown | Promise<unknown>) | undefined;
    const client: CursorAcpClient = {
      onNotification(method, handler) {
        if (method === "session/update") {
          void handler(messageChunk("should not complete"));
        }
      },
      onRequest(method, handler) {
        if (method === "session/request_permission") {
          permissionHandler = handler;
        }
      },
      async request(method) {
        if (method === "initialize" || method === "authenticate") return {};
        if (method === "session/new") return { sessionId: "s1" };
        if (method === "session/prompt") {
          const result = await permissionHandler?.(
            {
              toolCall: { title: "Edit src/x.ts" },
              options: [{ optionId: "allow-once" }, { optionId: "reject-once" }]
            },
            7
          );
          expect((result as { outcome?: { optionId?: string } })?.outcome?.optionId).toBe(
            "reject-once"
          );
          return { stopReason: "end_turn" };
        }
        if (method === "session/cancel") return {};
        return {};
      },
      async close() {}
    };

    const adapter = new CursorAcpAdapter({
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 5_000,
      createAcpClient: () => client
    });

    await expect(
      adapter.inspect({
        requestId: "req_perm",
        question: "inspect"
      })
    ).rejects.toMatchObject({ code: "agent_permission_denied" });
  });

  it("reports headlessToolActivity true for Cursor after Prompt 4", () => {
    expect(CODING_AGENT_OWNER_VISIBILITY.cursor.headlessToolActivity).toBe(true);
  });
});
