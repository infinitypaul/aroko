import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { buildProposalPrompt } from "./prompt.js";
import {
  PROPOSAL_PROVIDER_BEGIN,
  PROPOSAL_PROVIDER_END,
  parseProviderProposalResponse,
  providerProposalToUnifiedDiff
} from "./proposal-provider-response.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "propose-payment-service");

function wrapClaudeStdout(resultText: string): string {
  return JSON.stringify({ result: resultText, is_error: false });
}

function validProposalBlock(overrides?: {
  path?: string;
  patch?: string;
  summary?: string;
  version?: string;
  files?: unknown;
}): string {
  const body = {
    version: overrides?.version ?? "pairmesh.proposal-provider.v1",
    summary:
      overrides?.summary ??
      "Preserve the original payment reference when rebuilding from a retry record.",
    files: overrides?.files ?? [
      {
        path: overrides?.path ?? "src/retry.ts",
        patch:
          overrides?.patch ??
          [
            "@@ -9,7 +9,7 @@ export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {",
            "   return {",
            '-    reference: `retry:${retryRecord.customerId ?? "unknown"}`,',
            "+    reference: retryRecord.reference,",
            "     customerId: retryRecord.customerId ?? null",
            "   };"
          ].join("\n")
      }
    ]
  };
  return `${PROPOSAL_PROVIDER_BEGIN}\n${JSON.stringify(body, null, 2)}\n${PROPOSAL_PROVIDER_END}`;
}

describe("parseProviderProposalResponse", () => {
  it("parses a valid structured proposal block", () => {
    const parsed = parseProviderProposalResponse(validProposalBlock());
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe("src/retry.ts");
    const diff = providerProposalToUnifiedDiff(parsed);
    expect(diff).toContain("diff --git a/src/retry.ts b/src/retry.ts");
    expect(diff).toContain("+    reference: retryRecord.reference,");
  });

  it("rejects malformed JSON", () => {
    expect(() =>
      parseProviderProposalResponse(
        `${PROPOSAL_PROVIDER_BEGIN}\n{not-json}\n${PROPOSAL_PROVIDER_END}`
      )
    ).toThrow(/not valid JSON/i);
  });

  it("rejects empty files array", () => {
    expect(() => parseProviderProposalResponse(validProposalBlock({ files: [] }))).toThrow(
      /no file changes/i
    );
  });

  it("rejects unsupported version", () => {
    expect(() =>
      parseProviderProposalResponse(
        validProposalBlock({ version: "pairmesh.proposal-provider.v0" })
      )
    ).toThrow(/unsupported provider proposal version/i);
  });
});

describe("ClaudeCodeAdapter.proposeChange", () => {
  it("buildProposalPrompt embeds instruction as untrusted data", () => {
    const prompt = buildProposalPrompt("Preserve payment reference");
    expect(prompt).toContain("pairmesh.proposal-provider.v1");
    expect(prompt).toContain("Preserve payment reference");
    expect(prompt.toLowerCase()).toMatch(/must not modify|must not.*files|read-only/);
  });

  it("invokes Claude with stream-json and read-only tools and returns a structured proposal", async () => {
    const runProcess = vi.fn(async (input: { args: string[]; cwd: string }) => {
      expect(input.cwd).toBe(fixtureWorkspace);
      expect(input.args).toContain("--print");
      expect(input.args).toContain("--output-format");
      expect(input.args).toContain("stream-json");
      expect(input.args).toContain("--verbose");
      expect(input.args).toContain("--permission-mode");
      expect(input.args).toContain("dontAsk");
      expect(input.args).toContain("--allowedTools");
      expect(input.args).toContain("Read,Grep,Glob");
      expect(input.args.join(" ")).not.toMatch(/\bWrite\b|\bEdit\b|\bBash\b/);
      const printIndex = input.args.indexOf("--print");
      expect(input.args[printIndex + 1]).toContain("pairmesh.proposal-provider.v1");
      return {
        exitCode: 0,
        stdout: wrapClaudeStdout(validProposalBlock()),
        stderr: ""
      };
    });

    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });
    expect(adapter.provider.capabilities.proposeChange).toBe(true);

    const result = await adapter.proposeChange({
      instruction:
        "Propose a fix so retry reconstruction preserves the original payment reference.",
      requestId: "req_propose_1"
    });

    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(result.summary.toLowerCase()).toContain("payment reference");
    expect(result.unifiedDiff).toContain("src/retry.ts");
    expect(result.unifiedDiff).toContain("retryRecord.reference");
    expect(result.providerMetadata?.mutatedWorkingTree).toBe(false);
    expect(result.providerMetadata?.allowedTools).toBe("Read,Grep,Glob");
  });

  it("fails closed on malformed provider output without enabling writes", async () => {
    const runProcess = vi.fn(async (input: { args: string[] }) => {
      expect(input.args).toContain("Read,Grep,Glob");
      return {
        exitCode: 0,
        stdout: wrapClaudeStdout("Sorry, I cannot help with that."),
        stderr: ""
      };
    });
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });
    await expect(
      adapter.proposeChange({
        instruction: "fix retry reference",
        requestId: "req_propose_bad"
      })
    ).rejects.toMatchObject({ code: "pairmesh.proposal_invalid" });
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("emits truthful rich activity from stream-json tool_use and maps process failure", async () => {
    const retryAbs = join(fixtureWorkspace, "src", "retry.ts");
    const proposal = validProposalBlock();
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          uuid: "1",
          session_id: "s1"
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "2",
          session_id: "s1",
          parent_tool_use_id: null,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Read",
                input: { file_path: retryAbs }
              }
            ]
          }
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          uuid: "3",
          session_id: "s1",
          is_error: false,
          result: proposal,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: []
        })
      ].join("\n"),
      stderr: ""
    }));

    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess
    });
    const events: { activityKind?: string; message?: string; visibility?: string }[] = [];
    const result = await adapter.proposeChange(
      {
        instruction: "Preserve original payment reference in retry rebuild.",
        requestId: "req_rich_1"
      },
      {
        onProviderActivity: (event) => {
          events.push({
            activityKind: event.activityKind,
            message: event.message,
            visibility: event.visibility
          });
        }
      }
    );

    expect(result.unifiedDiff).toContain("src/retry.ts");
    expect(result.providerMetadata?.richToolActivity).toBe(true);
    expect(events.some((event) => event.activityKind === "file.read")).toBe(true);
    expect(events.some((event) => event.message?.includes("src/retry.ts"))).toBe(true);
    expect(events.map((event) => event.activityKind)).toContain("worker.started");
    expect(events.map((event) => event.activityKind)).toContain("proposal.ready");
    expect(events.map((event) => event.activityKind)).toContain("worker.completed");
    expect(JSON.stringify(events)).not.toMatch(/\/Users\//);

    const failing = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "claude crashed"
      })
    });
    const failEvents: string[] = [];
    await expect(
      failing.proposeChange(
        { instruction: "fix retry", requestId: "req_fail" },
        {
          onProviderActivity: (event) => {
            if (event.activityKind) {
              failEvents.push(event.activityKind);
            }
          }
        }
      )
    ).rejects.toMatchObject({ code: "agent_execution_failed" });
    expect(failEvents).toContain("worker.failed");
  });
});
