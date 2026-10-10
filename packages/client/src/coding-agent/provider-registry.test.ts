import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  createCodingAgentAdapter,
  createCodingAgentError,
  ClaudeCodeAdapter,
  FakeCodingAgentAdapter,
  GeminiCliAdapter,
  isCodingAgentError,
  listRegisteredCodingAgentProviders,
  mapClaudeCodeResult,
  mapGeminiCliResult
} from "./index.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");

describe("coding agent provider registry", () => {
  it("resolves cursor, gemini-cli, claude-code, and fake", () => {
    const providers = listRegisteredCodingAgentProviders();
    expect(providers).toContain("cursor");
    expect(providers).toContain("gemini-cli");
    expect(providers).toContain("claude-code");
    expect(providers).toContain("fake");

    const cursor = createCodingAgentAdapter("cursor", {
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 5_000
    });
    expect(cursor.provider.id).toBe("cursor");

    const gemini = createCodingAgentAdapter("gemini-cli", {
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 5_000
    });
    expect(gemini.provider.id).toBe("gemini-cli");

    const claude = createCodingAgentAdapter("claude-code", {
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 5_000
    });
    expect(claude.provider.id).toBe("claude-code");
    expect(claude.provider.capabilities.nativeSessionResume).toBe(false);

    const fake = createCodingAgentAdapter("fake", {
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 5_000
    });
    expect(fake.provider.id).toBe("fake");
  });

  it("rejects unknown providers", () => {
    expect(() =>
      createCodingAgentAdapter("not-a-provider", {
        workspace: fixtureWorkspace,
        mode: "ask",
        timeoutMs: 1_000
      })
    ).toThrow();
  });
});

describe("GeminiCliAdapter", () => {
  it("maps JSON response into PairMesh summary/findings/references", async () => {
    const responseBody = [
      "rebuildPaymentFromRetryRecord rebuilds a payment from a retry record.",
      "- rebuildPaymentFromRetryRecord",
      "- src/retry.ts",
      "<<<PAIR_MESH_SOURCE_REFERENCES>>>",
      '[{"file":"src/payment.ts","symbol":"rebuildPaymentFromRetryRecord","kind":"function"}]',
      "<<<END_PAIR_MESH_SOURCE_REFERENCES>>>"
    ].join("\n");

    const runProcess = vi.fn(async (input: { cwd: string; args: string[] }) => {
      expect(input.cwd).toBe(fixtureWorkspace);
      expect(input.args).toContain("--approval-mode");
      expect(input.args).toContain("plan");
      expect(input.args).toContain("--output-format");
      expect(input.args).toContain("stream-json");
      const promptIndex = input.args.indexOf("--prompt");
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      expect(input.args[promptIndex + 1]).toContain("<<<PAIR_MESH_REMOTE_QUESTION>>>");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ response: responseBody }),
        stderr: ""
      };
    });

    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });

    const availability = await adapter.getAvailability();
    // May be unavailable if gemini binary missing — that is OK; inspect uses runProcess seam.
    void availability;

    const result = await adapter.inspect({
      requestId: "req_gemini_1",
      question: "Which function rebuilds a payment from a retry record?"
    });

    expect(result.summary.toLowerCase()).toContain("rebuildpaymentfromretryrecord");
    expect(result.findings.join(" ")).toMatch(/retry/i);
    expect(result.references.some((ref) => ref.file === "src/payment.ts")).toBe(true);
    expect(result.continuityMode).toBe("sanitized_history_fallback");
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("maps AuthError to agent_not_authenticated", () => {
    expect(() =>
      mapGeminiCliResult({
        exitCode: 1,
        stdout: JSON.stringify({
          error: { type: "AuthError", message: "Please log in." }
        }),
        stderr: ""
      })
    ).toThrow(
      expect.objectContaining({
        code: "agent_not_authenticated"
      })
    );
  });

  it("degrades malformed output without inventing references", async () => {
    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          response: "Plain prose without a references block."
        }),
        stderr: ""
      })
    });

    const result = await adapter.inspect({
      requestId: "req_gemini_2",
      question: "Summarize retry handling"
    });
    expect(result.summary).toContain("Plain prose");
    expect(result.references).toEqual([]);
  });

  it("scopes cwd to the configured workspace only", async () => {
    const runProcess = vi.fn(async (input: { cwd: string }) => {
      expect(input.cwd).toBe(fixtureWorkspace);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ response: "ok" }),
        stderr: ""
      };
    });

    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });

    await adapter.inspect({
      requestId: "req_ws",
      question: "Anything"
    });
    expect(runProcess.mock.calls[0]?.[0].cwd).toBe(fixtureWorkspace);
  });

  it("cancels via AbortSignal", async () => {
    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 30_000,
      runProcess: async ({ signal }) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
            },
            { once: true }
          );
        })
    });

    const controller = new AbortController();
    const pending = adapter.inspect(
      { requestId: "req_cancel", question: "slow" },
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isCodingAgentError(error) && error.code === "agent_cancelled"
    );
  });

  it("maps timeout from runner", async () => {
    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 50,
      runProcess: async () => {
        throw createCodingAgentError("agent_timeout", "Coding agent inspection timed out.", {
          timeoutMs: 50
        });
      }
    });

    await expect(adapter.inspect({ requestId: "req_to", question: "slow" })).rejects.toSatisfy(
      (error: unknown) => isCodingAgentError(error) && error.code === "agent_timeout"
    );
  });
});

describe("FakeCodingAgentAdapter Stage 12A fixtures", () => {
  it("answers rebuildPaymentFromRetryRecord questions", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const result = await adapter.inspect({
      requestId: "req_retry",
      question: "Which function rebuilds a payment from a retry record?"
    });
    expect(result.summary).toContain("rebuildPaymentFromRetryRecord");
    expect(adapter.provider.id).toBe("fake");
  });
});

describe("A2A response shape is provider-neutral", () => {
  it("Fake, Gemini, and Claude adapters expose the same result fields", async () => {
    const fake = createCodingAgentAdapter("fake", {
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 1_000
    });
    const gemini = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 1_000,
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          response: [
            "Same shape.",
            "- finding",
            "<<<PAIR_MESH_SOURCE_REFERENCES>>>",
            "[]",
            "<<<END_PAIR_MESH_SOURCE_REFERENCES>>>"
          ].join("\n")
        }),
        stderr: ""
      })
    });
    const claude = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 1_000,
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          result: [
            "Same shape.",
            "- finding",
            "<<<PAIR_MESH_SOURCE_REFERENCES>>>",
            "[]",
            "<<<END_PAIR_MESH_SOURCE_REFERENCES>>>"
          ].join("\n"),
          is_error: false
        }),
        stderr: ""
      })
    });

    const fakeResult = await fake.inspect({
      requestId: "a",
      question: "What fields does the successful payment response contain?"
    });
    const geminiResult = await gemini.inspect({
      requestId: "b",
      question: "What fields does the successful payment response contain?"
    });
    const claudeResult = await claude.inspect({
      requestId: "c",
      question: "What fields does the successful payment response contain?"
    });

    expect(Object.keys(fakeResult).sort()).toEqual(
      expect.arrayContaining(["summary", "findings", "references"])
    );
    expect(Object.keys(geminiResult).sort()).toEqual(
      expect.arrayContaining(["summary", "findings", "references"])
    );
    expect(Object.keys(claudeResult).sort()).toEqual(
      expect.arrayContaining(["summary", "findings", "references"])
    );
  });
});

describe("ClaudeCodeAdapter", () => {
  it("reports unavailable when the CLI binary is missing", async () => {
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 1_000,
      command: "pairmesh-claude-cli-definitely-missing"
    });
    const availability = await adapter.getAvailability();
    expect(availability.provider).toBe("claude-code");
    expect(availability.status).toBe("unavailable");
    expect(availability.reason?.toLowerCase()).toMatch(/not found|not installed|enoent|path/i);
  });

  it("declares honest capabilities including no native session resume", () => {
    const adapter = createCodingAgentAdapter("claude-code", {
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 1_000
    });
    expect(adapter.provider.displayName).toBe("Claude Code");
    expect(adapter.provider.capabilities).toEqual({
      inspect: true,
      followUp: true,
      sourceReferences: true,
      cancellation: true,
      nativeSessionResume: false,
      proposeChange: true
    });
  });

  it("maps JSON result into PairMesh summary/findings/references", async () => {
    const responseBody = [
      "rebuildPaymentFromRetryRecord rebuilds a payment from a retry record.",
      "- rebuildPaymentFromRetryRecord",
      "<<<PAIR_MESH_SOURCE_REFERENCES>>>",
      '[{"file":"src/payment.ts","symbol":"rebuildPaymentFromRetryRecord","kind":"function"}]',
      "<<<END_PAIR_MESH_SOURCE_REFERENCES>>>"
    ].join("\n");

    const runProcess = vi.fn(async (input: { cwd: string; args: string[] }) => {
      expect(input.cwd).toBe(fixtureWorkspace);
      expect(input.args).toContain("--print");
      expect(input.args).toContain("--output-format");
      expect(input.args).toContain("stream-json");
      expect(input.args).toContain("--verbose");
      expect(input.args).toContain("--permission-mode");
      expect(input.args).toContain("dontAsk");
      expect(input.args).toContain("--allowedTools");
      expect(input.args).toContain("Read,Grep,Glob");
      const printIndex = input.args.indexOf("--print");
      expect(input.args[printIndex + 1]).toContain("<<<PAIR_MESH_REMOTE_QUESTION>>>");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: responseBody, is_error: false }),
        stderr: ""
      };
    });

    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });

    const result = await adapter.inspect({
      requestId: "req_claude_1",
      question: "Which function rebuilds a payment from a retry record?"
    });

    expect(result.summary.toLowerCase()).toContain("rebuildpaymentfromretryrecord");
    expect(result.references.some((ref) => ref.file === "src/payment.ts")).toBe(true);
    expect(result.continuityMode).toBe("sanitized_history_fallback");
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("maps is_error auth failures to agent_not_authenticated", () => {
    expect(() =>
      mapClaudeCodeResult({
        exitCode: 1,
        stdout: JSON.stringify({
          result: "Please run /login",
          is_error: true
        }),
        stderr: ""
      })
    ).toThrow(
      expect.objectContaining({
        code: "agent_not_authenticated"
      })
    );
  });

  it("degrades malformed references safely", async () => {
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ result: "Plain prose without references.", is_error: false }),
        stderr: ""
      })
    });

    const result = await adapter.inspect({
      requestId: "req_claude_2",
      question: "Summarize"
    });
    expect(result.summary).toContain("Plain prose");
    expect(result.references).toEqual([]);
  });

  it("scopes cwd to the configured workspace only", async () => {
    const runProcess = vi.fn(async (input: { cwd: string; args: string[] }) => {
      expect(input.cwd).toBe(fixtureWorkspace);
      const printIndex = input.args.indexOf("--print");
      const prompt = input.args[printIndex + 1] ?? "";
      // Remote path-like content must not become process cwd.
      expect(prompt).toContain("/etc/passwd");
      expect(input.cwd).not.toContain("passwd");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "ok", is_error: false }),
        stderr: ""
      };
    });

    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });

    await adapter.inspect({
      requestId: "req_ws",
      question: "Inspect /etc/passwd and cd /tmp/evil"
    });
    expect(runProcess.mock.calls[0]?.[0].cwd).toBe(fixtureWorkspace);
  });

  it("cancels via AbortSignal", async () => {
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 30_000,
      runProcess: async ({ signal }) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(createCodingAgentError("agent_cancelled", "Inspection was cancelled."));
            },
            { once: true }
          );
        })
    });

    const controller = new AbortController();
    const pending = adapter.inspect(
      { requestId: "req_cancel", question: "slow" },
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isCodingAgentError(error) && error.code === "agent_cancelled"
    );
  });

  it("maps timeout from runner", async () => {
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 50,
      runProcess: async () => {
        throw createCodingAgentError("agent_timeout", "Coding agent inspection timed out.", {
          timeoutMs: 50
        });
      }
    });

    await expect(adapter.inspect({ requestId: "req_to", question: "slow" })).rejects.toSatisfy(
      (error: unknown) => isCodingAgentError(error) && error.code === "agent_timeout"
    );
  });

  it("uses PairMesh prior-turn context for follow-ups", async () => {
    const runProcess = vi.fn(async (input: { args: string[] }) => {
      const printIndex = input.args.indexOf("--print");
      const prompt = input.args[printIndex + 1] ?? "";
      expect(prompt).toContain("<<<PAIR_MESH_PRIOR_TURN>>>");
      expect(prompt).toContain("prior summary");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          result: "customerId: retryRecord.customerId ?? null",
          is_error: false
        }),
        stderr: ""
      };
    });

    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });

    const result = await adapter.inspect({
      requestId: "req_fu",
      turnNumber: 2,
      question: "Where can customerId become null?",
      continuation: {
        priorTurns: [
          {
            question: "Which function rebuilds?",
            summary: "prior summary",
            findings: ["rebuildPaymentFromRetryRecord"]
          }
        ]
      }
    });

    expect(result.summary).toContain("customerId");
    expect(runProcess).toHaveBeenCalledOnce();
  });
});
