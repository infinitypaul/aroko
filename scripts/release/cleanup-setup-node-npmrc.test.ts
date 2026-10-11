/**
 * S23-7S — Simulated actions/setup-node .npmrc must not fail release dirty-tree checks
 * after the pack-job cleanup sequence (and must remain ignored in-repo).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("S23-7S setup-node .npmrc cleanup", () => {
  it("removes simulated setup-node .npmrc that would otherwise dirty porcelain", () => {
    const dir = mkdtempSync(join(tmpdir(), "aroko-npmrc-"));
    try {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "test"]);
      writeFileSync(join(dir, "README"), "x\n");
      // No .gitignore entry — matches the alpha.2 failure mode.
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);

      writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n");
      expect(git(dir, ["status", "--porcelain"])).toContain(".npmrc");

      execFileSync("rm", ["-f", ".npmrc"], { cwd: dir });
      expect(existsSync(join(dir, ".npmrc"))).toBe(false);
      expect(git(dir, ["status", "--porcelain"])).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps porcelain clean when .npmrc is gitignored (current main)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aroko-npmrc-ign-"));
    try {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "test"]);
      writeFileSync(join(dir, "README"), "x\n");
      writeFileSync(join(dir, ".gitignore"), ".npmrc\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n");
      expect(git(dir, ["status", "--porcelain"])).toBe("");
      execFileSync("rm", ["-f", ".npmrc"], { cwd: dir });
      expect(git(dir, ["status", "--porcelain"])).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports dirty porcelain for genuine source modifications", () => {
    const dir = mkdtempSync(join(tmpdir(), "aroko-dirty-"));
    try {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "test"]);
      writeFileSync(join(dir, "README"), "x\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      writeFileSync(join(dir, "README"), "changed\n");
      execFileSync("rm", ["-f", ".npmrc"], { cwd: dir });
      expect(git(dir, ["status", "--porcelain"])).toContain("README");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

  it("removes simulated public-export-excluded docs/validation test output", () => {
    const dir = mkdtempSync(join(tmpdir(), "aroko-valout-"));
    try {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "test"]);
      writeFileSync(join(dir, "README"), "x\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      execFileSync("mkdir", ["-p", "docs/validation/r5-7-ux-evidence"], { cwd: dir });
      writeFileSync(join(dir, "docs/validation/r5-7-ux-evidence/out.json"), "{}\n");
      expect(git(dir, ["status", "--porcelain"])).toMatch(/docs\//);
      execFileSync("rm", ["-rf", "docs/validation"], { cwd: dir });
      execFileSync("rm", ["-f", ".npmrc"], { cwd: dir });
      expect(git(dir, ["status", "--porcelain"])).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

