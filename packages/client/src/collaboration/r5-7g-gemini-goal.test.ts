import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGoalHostMcpLaunch } from "./goal-host-mcp-config.js";
import {
  PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME,
  buildGeminiGoalMcpServerEntry,
  isArokoOwnedGeminiGoalServer,
  provisionGeminiGoalMcp,
  reconcileStaleGeminiGoalMcp,
  restoreGeminiGoalMcp
} from "./gemini-goal-mcp-provision.js";
import { extractGeminiHostToolUse } from "./goal-task-worker.js";
import { PAIRMESH_HOST_REQUEST_TOOLS } from "@pairmesh/protocol";

describe("R5-7G Gemini goal MCP provisioning", () => {
  it("preserves pre-existing settings and MCP servers after restore", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r57g-cfg-"));
    await mkdir(join(workspace, ".gemini"), { recursive: true });
    const prior = {
      theme: "dark",
      mcpServers: {
        "github-write": { command: "npx", args: ["-y", "fake-github"] }
      },
      unrelated: { keep: true }
    };
    const priorRaw = `${JSON.stringify(prior, null, 2)}\n`;
    await writeFile(join(workspace, ".gemini", "settings.json"), priorRaw, "utf8");

    const provision = await provisionGeminiGoalMcp({
      workspaceRoot: workspace,
      launch: buildGoalHostMcpLaunch()
    });
    const mid = JSON.parse(await readFile(provision.settingsPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
      mcp: { allowed: string[] };
      theme: string;
      unrelated: { keep: boolean };
    };
    expect(mid.theme).toBe("dark");
    expect(mid.unrelated.keep).toBe(true);
    expect(mid.mcpServers["github-write"]).toEqual(prior.mcpServers["github-write"]);
    expect(mid.mcpServers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME]).toBeTruthy();
    expect(isArokoOwnedGeminiGoalServer(mid.mcpServers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME])).toBe(
      true
    );
    expect(mid.mcp.allowed).toEqual([PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME]);
    const entry = mid.mcpServers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME] as {
      includeTools: string[];
      trust: boolean;
    };
    expect(entry.trust).toBe(true);
    expect(entry.includeTools).toEqual([...PAIRMESH_HOST_REQUEST_TOOLS]);
    expect((mid as { tools?: { exclude?: string[] } }).tools?.exclude).toEqual(
      expect.arrayContaining(["run_shell_command", "write_file", "replace"])
    );
    await restoreGeminiGoalMcp({ workspaceRoot: workspace, provision });
    const restored = await readFile(join(workspace, ".gemini", "settings.json"), "utf8");
    expect(restored).toBe(priorRaw);
  });

  it("removes settings file when none existed before provision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r57g-empty-"));
    const provision = await provisionGeminiGoalMcp({ workspaceRoot: workspace });
    expect(await readFile(provision.settingsPath, "utf8")).toContain(
      PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME
    );
    await restoreGeminiGoalMcp({ workspaceRoot: workspace, provision });
    await expect(readFile(join(workspace, ".gemini", "settings.json"), "utf8")).rejects.toThrow();
  });

  it("reconcile restores from backup after simulated crash", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r57g-crash-"));
    await mkdir(join(workspace, ".gemini"), { recursive: true });
    const prior = `${JSON.stringify({ keep: "me", mcpServers: { other: { command: "x" } } }, null, 2)}\n`;
    await writeFile(join(workspace, ".gemini", "settings.json"), prior, "utf8");
    const provision = await provisionGeminiGoalMcp({ workspaceRoot: workspace });
    // Crash: leave backup + mutated settings, skip restore.
    expect(provision.backupPath).toBeTruthy();
    const result = await reconcileStaleGeminiGoalMcp(workspace);
    expect(result.restoredFromBackup).toBe(true);
    const restored = await readFile(join(workspace, ".gemini", "settings.json"), "utf8");
    expect(restored).toBe(prior);
  });

  it("does not remove non-Aroko pairmesh_goal-named servers without ownership mark", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r57g-user-"));
    await mkdir(join(workspace, ".gemini"), { recursive: true });
    const userOwned = {
      mcpServers: {
        [PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME]: { command: "user-owned", args: [] }
      }
    };
    await writeFile(
      join(workspace, ".gemini", "settings.json"),
      `${JSON.stringify(userOwned, null, 2)}\n`,
      "utf8"
    );
    const result = await reconcileStaleGeminiGoalMcp(workspace);
    expect(result.removedStaleServer).toBe(false);
    const raw = await readFile(join(workspace, ".gemini", "settings.json"), "utf8");
    expect(JSON.parse(raw).mcpServers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME].command).toBe(
      "user-owned"
    );
  });

  it("buildGeminiGoalMcpServerEntry marks ownership and includeTools", () => {
    const entry = buildGeminiGoalMcpServerEntry(buildGoalHostMcpLaunch(), "tok");
    expect(isArokoOwnedGeminiGoalServer(entry)).toBe(true);
    expect(entry.includeTools).toHaveLength(5);
  });
  it("serializes concurrent provision via lock without corrupting prior settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r57g-lock-"));
    await mkdir(join(workspace, ".gemini"), { recursive: true });
    const prior = `${JSON.stringify({ theme: "light", mcpServers: { keep: { command: "k" } } }, null, 2)}\n`;
    await writeFile(join(workspace, ".gemini", "settings.json"), prior, "utf8");

    const first = await provisionGeminiGoalMcp({ workspaceRoot: workspace });
    const secondPromise = provisionGeminiGoalMcp({ workspaceRoot: workspace });
    // Second should block until first restores.
    await new Promise((r) => setTimeout(r, 80));
    await restoreGeminiGoalMcp({ workspaceRoot: workspace, provision: first });
    const second = await secondPromise;
    await restoreGeminiGoalMcp({ workspaceRoot: workspace, provision: second });
    const restored = await readFile(join(workspace, ".gemini", "settings.json"), "utf8");
    expect(restored).toBe(prior);
  });

  it("refuses restore when settings changed underneath Aroko", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r57g-race-"));
    await mkdir(join(workspace, ".gemini"), { recursive: true });
    const prior = `${JSON.stringify({ keep: true }, null, 2)}\n`;
    await writeFile(join(workspace, ".gemini", "settings.json"), prior, "utf8");
    const provision = await provisionGeminiGoalMcp({ workspaceRoot: workspace });
    await writeFile(
      join(workspace, ".gemini", "settings.json"),
      `${JSON.stringify({ hijacked: true }, null, 2)}\n`,
      "utf8"
    );
    await expect(restoreGeminiGoalMcp({ workspaceRoot: workspace, provision })).rejects.toThrow(
      /refusing to overwrite/i
    );
  });
});

describe("R5-7G extractGeminiHostToolUse", () => {
  it("extracts structured stream-json tool_use for request_*", () => {
    const stream = [
      JSON.stringify({ type: "init", model: "gemini" }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "request_requester_input",
        tool_id: "t1",
        parameters: { question: "Which Node major?" }
      })
    ].join("\n");
    const hit = extractGeminiHostToolUse(stream);
    expect(hit).toEqual({
      toolName: "request_requester_input",
      args: { question: "Which Node major?" }
    });
  });

  it("accepts Gemini mcp_ FQN tool names", () => {
    const stream = JSON.stringify({
      type: "tool_use",
      tool_name: "mcp_pairmesh-goal_request_process_execution",
      parameters: { executable: "node", args: ["--version"] }
    });
    const hit = extractGeminiHostToolUse(stream);
    expect(hit?.toolName).toBe("mcp_pairmesh-goal_request_process_execution");
  });

  it("ignores unrelated MCP tool_use events", () => {
    const stream = JSON.stringify({
      type: "tool_use",
      tool_name: "dangerous_test_action",
      parameters: { wipe: true }
    });
    expect(extractGeminiHostToolUse(stream)).toBeNull();
  });
});
