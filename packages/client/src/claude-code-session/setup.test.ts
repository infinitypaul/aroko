import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installClaudeReceiverAwareness,
  isClaudeSessionRegistered,
  nodeEvalCommand
} from "./setup.js";

type HookCommand = { hooks: Array<{ type: string; command: string }> };

describe("Stage 16 Prompt 4 — Claude receiver awareness setup", () => {
  it("nodeEvalCommand keeps path literals shell-safe for node -e", () => {
    const path =
      "/Users/infinitypaul/Sites/got-photo/pm/payment-service/.pairmesh/claude-session.json";
    const cmd = nodeEvalCommand(`const p=${JSON.stringify(path)};`);
    expect(cmd.startsWith("node -e ")).toBe(true);
    const evalSource = JSON.parse(cmd.slice("node -e ".length)) as string;
    expect(evalSource).toContain(`const p="${path}";`);
    expect(() => new Function(evalSource)).not.toThrow();
  });

  it("writes receiver MCP role and hooks without approve tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pairmesh-claude-setup-"));
    const result = await installClaudeReceiverAwareness({
      workspace: root,
      write: true,
      force: true
    });
    expect(result.supported).toBe(true);
    expect(result.wrote).toBe(true);

    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: { aroko: { env: Record<string, string> } };
    };
    expect(mcp.mcpServers.aroko.env.PAIRMESH_MCP_ROLE).toBe("receiver");
    expect(mcp.mcpServers.aroko.env.AROKO_MCP_ROLE).toBe("receiver");

    const settings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8")) as {
      hooks: {
        SessionStart: HookCommand[];
        SessionEnd: HookCommand[];
        Stop: HookCommand[];
      };
    };
    expect(settings.hooks.SessionStart).toBeTruthy();
    expect(settings.hooks.SessionEnd).toBeTruthy();
    expect(JSON.stringify(settings)).not.toMatch(/approve/i);

    for (const event of ["SessionStart", "SessionEnd", "Stop"] as const) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(command.startsWith("node -e ")).toBe(true);
      const evalSource = JSON.parse(command.slice("node -e ".length)) as string;
      expect(() => new Function(evalSource)).not.toThrow();
      expect(evalSource).not.toMatch(/const p=\//);
    }

    expect(await isClaudeSessionRegistered(root)).toBe(false);
  });
});
