import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CursorAcpAdapter, type CursorAcpClient } from "./cursor-adapter.js";
import {
  PROPOSAL_PROVIDER_BEGIN,
  PROPOSAL_PROVIDER_END,
  parseProviderProposalResponse
} from "./proposal-provider-response.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

function proposalBlock(): string {
  const body = {
    version: "pairmesh.proposal-provider.v1",
    summary: "Update greet return value to hello world.",
    files: [
      {
        path: "src/greet.js",
        patch: [
          "@@ -1,3 +1,3 @@",
          " export function greet() {",
          '-  return "hello";',
          '+  return "hello world";',
          " }"
        ].join("\n")
      }
    ]
  };
  return `${PROPOSAL_PROVIDER_BEGIN}\n${JSON.stringify(body, null, 2)}\n${PROPOSAL_PROVIDER_END}`;
}

function messageChunk(text: string) {
  return {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text }
    }
  };
}

describe("S23-6A — CursorAcpAdapter.proposeChange", () => {
  it("advertises proposeChange=true", () => {
    const adapter = new CursorAcpAdapter({
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 5_000,
      createAcpClient: () => ({
        onNotification() {},
        onRequest() {},
        async request() {
          return {};
        },
        async close() {}
      })
    });
    expect(adapter.provider.capabilities.proposeChange).toBe(true);
  });

  it("parses structured proposal from ACP text without write/terminal capabilities", async () => {
    let initializeParams: unknown;
    let notificationHandler: ((params: unknown) => void) | undefined;
    let permissionHandler:
      ((params: unknown, id: number) => unknown | Promise<unknown>) | undefined;

    const client: CursorAcpClient = {
      onNotification(method, handler) {
        if (method === "session/update") {
          notificationHandler = handler;
        }
      },
      onRequest(method, handler) {
        if (method === "session/request_permission") {
          permissionHandler = handler;
        }
      },
      async request(method, params) {
        if (method === "initialize") {
          initializeParams = params;
          return {};
        }
        if (method === "authenticate") return {};
        if (method === "session/new") return { sessionId: "sess_propose" };
        if (method === "session/prompt") {
          expect(
            String((params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text)
          ).toContain("pairmesh.proposal-provider.v1");
          notificationHandler?.(messageChunk(proposalBlock()));
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

    const result = await adapter.proposeChange({
      instruction: 'Change greet() to return "hello world".',
      requestId: "req_cursor_propose_1"
    });

    const caps = (initializeParams as { clientCapabilities?: Record<string, unknown> })
      ?.clientCapabilities;
    expect(caps).toEqual({
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false
    });
    expect(permissionHandler).toBeTypeOf("function");
    expect(result.summary.toLowerCase()).toContain("hello world");
    expect(result.unifiedDiff).toContain("src/greet.js");
    expect(result.unifiedDiff).toContain('+  return "hello world";');
    expect(result.providerMetadata?.acpFsWriteTextFile).toBe(false);
    expect(result.providerMetadata?.acpTerminal).toBe(false);
    expect(result.providerMetadata?.mutatedWorkingTree).toBe(false);
  });

  it("fails closed on malformed proposal output", async () => {
    let notificationHandler: ((params: unknown) => void) | undefined;
    const client: CursorAcpClient = {
      onNotification(method, handler) {
        if (method === "session/update") notificationHandler = handler;
      },
      onRequest() {},
      async request(method) {
        if (method === "initialize" || method === "authenticate") return {};
        if (method === "session/new") return { sessionId: "s1" };
        if (method === "session/prompt") {
          notificationHandler?.(messageChunk("I cannot produce a proposal."));
          return { stopReason: "end_turn" };
        }
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
      adapter.proposeChange({
        instruction: "propose something",
        requestId: "req_bad"
      })
    ).rejects.toThrow(/structured proposal|not valid JSON|did not contain/i);
  });

  it("denies write-like ACP permissions during proposal", async () => {
    let permissionHandler:
      ((params: unknown, id: number) => unknown | Promise<unknown>) | undefined;
    const client: CursorAcpClient = {
      onNotification(method, handler) {
        if (method === "session/update") {
          void handler(messageChunk("should fail"));
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
          await permissionHandler?.(
            {
              toolCall: { title: "Write src/x.ts" },
              options: [{ optionId: "allow-once" }, { optionId: "reject-once" }]
            },
            1
          );
          return { stopReason: "end_turn" };
        }
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
      adapter.proposeChange({
        instruction: "x",
        requestId: "req_write_deny"
      })
    ).rejects.toMatchObject({ code: "agent_permission_denied" });
  });

  it("canonical validator rejects traversal and .pairmesh paths", async () => {
    const { parseAndNormalizeUnifiedDiff } = await import("../action/proposal/unified-diff.js");
    const { providerProposalToUnifiedDiff } = await import("./proposal-provider-response.js");

    const traversal = parseProviderProposalResponse(
      `${PROPOSAL_PROVIDER_BEGIN}\n${JSON.stringify({
        version: "pairmesh.proposal-provider.v1",
        summary: "bad traversal",
        files: [{ path: "../outside.js", patch: "@@ -1 +1 @@\n-a\n+b" }]
      })}\n${PROPOSAL_PROVIDER_END}`
    );
    await expect(
      parseAndNormalizeUnifiedDiff(providerProposalToUnifiedDiff(traversal), fixtureWorkspace)
    ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });

    const pairmesh = parseProviderProposalResponse(
      `${PROPOSAL_PROVIDER_BEGIN}\n${JSON.stringify({
        version: "pairmesh.proposal-provider.v1",
        summary: "bad pairmesh",
        files: [{ path: ".pairmesh/config.json", patch: "@@ -1 +1 @@\n-a\n+b" }]
      })}\n${PROPOSAL_PROVIDER_END}`
    );
    await expect(
      parseAndNormalizeUnifiedDiff(providerProposalToUnifiedDiff(pairmesh), fixtureWorkspace)
    ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });
  });
});
