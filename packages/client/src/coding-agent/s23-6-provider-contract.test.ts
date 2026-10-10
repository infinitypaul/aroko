import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CODE_PROVIDER,
  CURSOR_PROVIDER,
  FAKE_PROVIDER,
  GEMINI_CLI_PROVIDER,
  getBuiltinProviderDescriptor
} from "./descriptors.js";
import { createCodingAgentAdapter, listRegisteredCodingAgentProviders } from "./registry.js";
import { CODING_AGENT_ERROR_CODES } from "./types.js";
import {
  assertNoPeerUpdateCapabilities,
  isForbiddenPeerUpdateCapability
} from "../update/peer-boundary.js";
import { resolveRemoteGoalProviderId } from "../collaboration/task-remote-handler.js";
import { PAIRMESH_FUTURE_CAPABILITIES, PAIRMESH_GRANTABLE_CAPABILITIES } from "@pairmesh/protocol";

const REAL_PROVIDERS = ["cursor", "gemini-cli", "claude-code"] as const;

describe("S23-6 provider contract", () => {
  it("registers exactly the built-in providers", () => {
    const ids = listRegisteredCodingAgentProviders().sort();
    expect(ids).toEqual(["claude-code", "cursor", "fake", "gemini-cli"].sort());
  });

  it("exposes a shared inspect/progress capability shape for real providers", () => {
    for (const id of REAL_PROVIDERS) {
      const d = getBuiltinProviderDescriptor(id);
      expect(d.capabilities.inspect).toBe(true);
      expect(d.capabilities.followUp).toBe(true);
      expect(d.capabilities.sourceReferences).toBe(true);
      expect(d.capabilities.cancellation).toBe(true);
      expect(d.ownerVisibility.headlessToolActivity).toBe(true);
    }
  });

  it("documents proposeChange honestly", () => {
    expect(CLAUDE_CODE_PROVIDER.capabilities.proposeChange).toBe(true);
    expect(FAKE_PROVIDER.capabilities.proposeChange).toBe(true);
    expect(CURSOR_PROVIDER.capabilities.proposeChange).toBe(true);
    expect(GEMINI_CLI_PROVIDER.capabilities.proposeChange).toBe(false);
  });

  it("rejects unsupported provider ids", () => {
    expect(() => createCodingAgentAdapter("chatgpt-web", { workspace: process.cwd() })).toThrow(
      /Unsupported|misconfigured/i
    );
  });

  it("keeps coding-agent error taxonomy stable", () => {
    expect(CODING_AGENT_ERROR_CODES).toContain("agent_unavailable");
    expect(CODING_AGENT_ERROR_CODES).toContain("agent_not_authenticated");
    expect(CODING_AGENT_ERROR_CODES).toContain("agent_timeout");
    expect(CODING_AGENT_ERROR_CODES).toContain("agent_cancelled");
    expect(CODING_AGENT_ERROR_CODES).toContain("agent_execution_failed");
  });
});

describe("S23-6 provider selection authority", () => {
  it("remote goal provider comes from local receiver config only", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "aroko-s236-prov-"));
    try {
      mkdirSync(join(workspace, ".pairmesh"), { recursive: true });
      writeFileSync(
        join(workspace, ".pairmesh", "config.json"),
        JSON.stringify({
          configVersion: "0.1.0",
          projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          agent: { name: "recv", port: "auto" },
          workspace,
          codingAgent: { provider: "claude-code", mode: "ask" },
          connectivity: { mode: "relay" }
        })
      );
      expect(await resolveRemoteGoalProviderId({ workspaceRoot: workspace })).toBe("claude-code");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not expose software-update capabilities via peer surfaces", () => {
    expect(() => assertNoPeerUpdateCapabilities(PAIRMESH_GRANTABLE_CAPABILITIES)).not.toThrow();
    expect(() => assertNoPeerUpdateCapabilities(PAIRMESH_FUTURE_CAPABILITIES)).not.toThrow();
    for (const id of REAL_PROVIDERS) {
      expect(isForbiddenPeerUpdateCapability(id)).toBe(false);
    }
  });
});
