/**
 * S23-3 provenance invariants — uses temporary Git repositories only.
 * Never mutates the canonical infinitypaul/aroko-internal history.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  cpSync,
  readFileSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function nodeImport(cwd: string, scriptRel: string, env: Record<string, string> = {}) {
  return execFileSync("node", ["--input-type=module", "-e", scriptRel], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "s233-prov-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "s233@test.local"]);
  git(dir, ["config", "user.name", "S23-3 Provenance"]);
  // Minimal files mirroring version sources used by validators
  mkdirSync(join(dir, "apps/cli"), { recursive: true });
  mkdirSync(join(dir, "packages/protocol/src"), { recursive: true });
  mkdirSync(join(dir, "packages/client/src/session"), { recursive: true });
  mkdirSync(join(dir, "scripts/release"), { recursive: true });
  writeFileSync(
    join(dir, "apps/cli/package.json"),
    `${JSON.stringify({ name: "@pairmesh/cli", version: "0.1.0-alpha.1" }, null, 2)}\n`
  );
  writeFileSync(
    join(dir, "packages/protocol/src/version.ts"),
    `export const PAIRMESH_METADATA_VERSION = "0.1.0" as const;\n`
  );
  writeFileSync(
    join(dir, "packages/client/src/session/schemas.ts"),
    `export const LOCAL_STATE_VERSION = "0.6.0" as const;\n`
  );
  // Copy release scripts from canonical repo
  for (const name of ["git-identity.mjs", "validate-identity.mjs", "manifest.mjs"]) {
    cpSync(join(repoRoot, "scripts/release", name), join(dir, "scripts/release", name));
  }
  git(dir, ["remote", "add", "origin", "https://github.com/infinitypaul/aroko.git"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "test baseline"]);
  return dir;
}

function runValidate(cwd: string, mode: "development" | "release") {
  const script = `
    import { validateReleaseIdentity } from './scripts/release/validate-identity.mjs';
    const r = validateReleaseIdentity(process.cwd(), '${mode}');
    console.log(JSON.stringify(r));
  `;
  return JSON.parse(nodeImport(cwd, script));
}

function runValidateExpectFail(cwd: string, mode: "development" | "release") {
  const script = `
    import { validateReleaseIdentity } from './scripts/release/validate-identity.mjs';
    try {
      validateReleaseIdentity(process.cwd(), '${mode}');
      console.log(JSON.stringify({ ok: true }));
      process.exit(0);
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
      process.exit(2);
    }
  `;
  try {
    const out = nodeImport(cwd, script);
    return JSON.parse(out);
  } catch (error: unknown) {
    const err = error as { stdout?: string; status?: number };
    if (err.stdout) {
      return JSON.parse(err.stdout);
    }
    throw error;
  }
}

describe("S23-3 release provenance", () => {
  it("accepts clean checkout with matching annotated alpha tag (release)", () => {
    const dir = createTempRepo();
    try {
      const sha = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "test release"]);
      const result = runValidate(dir, "release");
      expect(result.gitCommit).toBe(sha);
      expect(result.gitTag).toBe("v0.1.0-alpha.1");
      expect(result.packageVersion).toBe("0.1.0-alpha.1");
      expect(result.isDirty).toBe(false);
      expect(result.releaseId).toContain("aroko-0.1.0-alpha.1-");
      expect(result.protocolVersion).toBe("0.1.0");
      expect(result.stateSchemaVersion).toBe("0.6.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects dirty working tree for release", () => {
    const dir = createTempRepo();
    try {
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "test release"]);
      writeFileSync(join(dir, "dirty.txt"), "x\n");
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("DIRTY_WORKING_TREE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing release tag", () => {
    const dir = createTempRepo();
    try {
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("MISSING_RELEASE_TAG");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed release tag", () => {
    const dir = createTempRepo();
    try {
      git(dir, ["tag", "-a", "v0.1.0", "-m", "bad"]);
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(["MALFORMED_RELEASE_TAG", "MISSING_RELEASE_TAG"]).toContain(result.code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects lightweight (non-annotated) alpha tag for release", () => {
    const dir = createTempRepo();
    try {
      git(dir, ["tag", "v0.1.0-alpha.1"]);
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("LIGHTWEIGHT_RELEASE_TAG");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects tag not at HEAD", () => {
    const dir = createTempRepo();
    try {
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "old"]);
      writeFileSync(
        join(dir, "apps/cli/package.json"),
        `${JSON.stringify({ name: "@pairmesh/cli", version: "0.1.0-alpha.1" }, null, 2)}\n`
      );
      writeFileSync(join(dir, "next.txt"), "n\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "advance head"]);
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("MISSING_RELEASE_TAG");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects version/tag mismatch", () => {
    const dir = createTempRepo();
    try {
      writeFileSync(
        join(dir, "apps/cli/package.json"),
        `${JSON.stringify({ name: "@pairmesh/cli", version: "0.1.0-alpha.2" }, null, 2)}\n`
      );
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "bump version"]);
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "mismatch"]);
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("VERSION_TAG_MISMATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts engineering canonical remote infinitypaul/aroko-internal for release", () => {
    const dir = createTempRepo();
    try {
      git(dir, [
        "remote",
        "set-url",
        "origin",
        "https://github.com/infinitypaul/aroko-internal.git"
      ]);
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "test"]);
      const result = runValidate(dir, "release");
      expect(result.gitTag).toBe("v0.1.0-alpha.1");
      expect(result.repositoryRole).toBe("engineering");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts temporary S23-7J clean recovery remote infinitypaul/aroko-public-clean", () => {
    const dir = createTempRepo();
    try {
      git(dir, [
        "remote",
        "set-url",
        "origin",
        "https://github.com/infinitypaul/aroko-public-clean.git"
      ]);
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "test"]);
      const result = runValidate(dir, "release");
      expect(result.gitTag).toBe("v0.1.0-alpha.1");
      expect(result.repositoryRole).toBe("public");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects wrong canonical remote for release", () => {
    const dir = createTempRepo();
    try {
      git(dir, ["remote", "set-url", "origin", "https://github.com/infinitypaul/pairmesh.git"]);
      git(dir, ["tag", "-a", "v0.1.0-alpha.1", "-m", "test"]);
      const result = runValidateExpectFail(dir, "release");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("WRONG_CANONICAL_REMOTE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds release manifest with sha256 binding", async () => {
    const dir = createTempRepo();
    try {
      const { buildReleaseManifest, sha256File, artifactEntryFromFile } =
        await import("./manifest.mjs");
      const blob = join(dir, "pairmesh-cli-0.1.0-alpha.1.tgz");
      writeFileSync(blob, "fake-tarball-bytes\n");
      const art = artifactEntryFromFile(blob);
      expect(art.sha256).toBe(sha256File(blob));
      const manifest = buildReleaseManifest({
        product: "Aroko",
        version: "0.1.0-alpha.1",
        releaseId: "aroko-0.1.0-alpha.1-deadbeef",
        gitCommit: "a".repeat(40),
        gitTag: "v0.1.0-alpha.1",
        builtAt: "2026-09-13T00:00:00Z",
        node: "v20.20.2",
        pnpm: "10.15.1",
        protocolVersion: "0.1.0",
        stateSchemaVersion: "0.6.0",
        artifacts: [art]
      });
      expect(manifest.artifacts[0]?.sha256).toBe(art.sha256);
      expect(() =>
        buildReleaseManifest({
          ...manifest,
          gitCommit: "unknown"
        })
      ).toThrow(/missing required field/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("development mode allows clean untagged checkout", () => {
    const dir = createTempRepo();
    try {
      const result = runValidate(dir, "development");
      expect(result.isDirty).toBe(false);
      expect(result.gitTag).toBeNull();
      expect(result.releaseId.startsWith("dev-")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
