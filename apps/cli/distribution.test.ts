import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const cliPackagePath = join(repoRoot, "apps/cli/package.json");
const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  engines: { node: string };
  files: string[];
  bundledDependencies: string[];
};

describe("distribution package metadata", () => {
  it("declares aroko primary bin and pairmesh alias", () => {
    expect(cliPackage.name).toBe("@pairmesh/cli");
    expect(cliPackage.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(cliPackage.bin.aroko).toBe("./dist/index.js");
    expect(cliPackage.bin.pairmesh).toBe("./dist/index.js");
  });

  it("declares node engine and distributable files", () => {
    expect(cliPackage.engines.node).toBe(">=20.0.0");
    expect(cliPackage.files).toEqual(["dist"]);
  });

  it("bundles internal workspace packages", () => {
    expect(cliPackage.bundledDependencies).toEqual(
      expect.arrayContaining([
        "@pairmesh/client",
        "@pairmesh/coordination",
        "@pairmesh/mcp",
        "@pairmesh/protocol",
        "@pairmesh/shared"
      ])
    );
  });

  it("built CLI entry exists after build", async () => {
    const { access } = await import("node:fs/promises");
    await expect(access(join(repoRoot, "apps/cli/dist/index.js"))).resolves.toBeUndefined();
    const raw = readFileSync(join(repoRoot, "apps/cli/dist/index.js"), "utf8");
    expect(raw.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
