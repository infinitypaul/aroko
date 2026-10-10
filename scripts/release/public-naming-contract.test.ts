/**
 * S23-7O — Explicit public naming / MCP identity contract (offline).
 * Product identity is Aroko; PairMesh remains a compatibility surface.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("S23-7O public naming contract", () => {
  it("publishes @arokodev/cli with dual bins aroko (primary) + pairmesh (compat)", () => {
    const packagePairmesh = readFileSync(join(repoRoot, "scripts/package-pairmesh.mjs"), "utf8");
    expect(packagePairmesh).toContain('PUBLIC_CLI_PACKAGE_NAME = "@arokodev/cli"');
    expect(packagePairmesh).toMatch(/bin:\s*\{[\s\S]*aroko:\s*"\.\/dist\/index\.js"/);
    expect(packagePairmesh).toMatch(/bin:\s*\{[\s\S]*pairmesh:\s*"\.\/dist\/index\.js"/);

    const workspaceCli = JSON.parse(
      readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")
    ) as { bin: Record<string, string> };
    expect(workspaceCli.bin.aroko).toBe("./dist/index.js");
    expect(workspaceCli.bin.pairmesh).toBe("./dist/index.js");
  });

  it("defines canonical MCP server key aroko with legacy pairmesh fallback helpers", () => {
    const branded = readFileSync(join(repoRoot, "packages/shared/src/branded-env.ts"), "utf8");
    expect(branded).toContain('export const MCP_SERVER_KEY_CANONICAL = "aroko"');
    expect(branded).toContain('export const MCP_SERVER_KEY_LEGACY = "pairmesh"');
    expect(branded).toContain("Prefer canonical `aroko` entry");

    const launch = readFileSync(
      join(repoRoot, "packages/client/src/cursor-mcp/mcp-launch.ts"),
      "utf8"
    );
    expect(launch).toContain('command: "aroko"');
    expect(launch).toContain('args: ["mcp"]');
    expect(launch).toContain('if (config.command === "aroko" || config.command === "pairmesh")');
  });

  it("clean-install validator asserts canonical MCP identity, not legacy-only", () => {
    const validate = readFileSync(join(repoRoot, "scripts/validate-clean-install.mjs"), "utf8");
    expect(validate).toContain("mcpServers.aroko");
    expect(validate).toContain('expected installed-mode MCP command "aroko"');
    expect(validate).not.toMatch(/expected installed-mode MCP command "pairmesh"/);
    expect(validate).toContain("which aroko");
    expect(validate).toContain("which pairmesh");
    expect(validate).toContain("Primary aroko and legacy pairmesh bins must report the same version");
    expect(validate).toContain("cursorMcpConfigFile");
  });

  it("mcp --print-config fragments use mcpServers.aroko", () => {
    const mcpCmd = readFileSync(join(repoRoot, "apps/cli/src/commands/mcp.ts"), "utf8");
    expect(mcpCmd).toContain("mcpServers: {");
    expect(mcpCmd).toContain("aroko: {");
    expect(mcpCmd).not.toMatch(/mcpServers:\s*\{\s*pairmesh:\s*\{/);
  });

  it("cursor setup writes canonical key and removes legacy on write", () => {
    const cursor = readFileSync(
      join(repoRoot, "packages/client/src/cursor-mcp/cursor-config.ts"),
      "utf8"
    );
    expect(cursor).toContain("MCP_SERVER_KEY_CANONICAL");
    expect(cursor).toContain("delete nextServers[MCP_SERVER_KEY_LEGACY]");
    expect(cursor).toContain("single mcpServers.aroko entry");
  });
});
