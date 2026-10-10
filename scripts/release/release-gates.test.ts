/**
 * S23-7J — Negative release-gate tests (offline).
 * These encode fail-closed expectations for publish identity checks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
const packagePairmesh = readFileSync(join(repoRoot, "scripts/package-pairmesh.mjs"), "utf8");
const publishCheck = readFileSync(join(repoRoot, "scripts/check-publish-readiness.mjs"), "utf8");
const updateConstants = readFileSync(
  join(repoRoot, "packages/client/src/update/constants.ts"),
  "utf8"
);

describe("S23-7J release gates", () => {
  it("does not publish on tag push alone", () => {
    expect(releaseWorkflow).toContain("confirm_publish");
    expect(releaseWorkflow).toMatch(
      /if:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.confirm_publish\s*==\s*true/
    );
    expect(releaseWorkflow).toContain("environment: production-release");
    expect(releaseWorkflow).toContain("Stop before external publish");
  });

  it("requires tag ref for confirm_publish path", () => {
    expect(releaseWorkflow).toContain("github.ref_type == 'tag'");
    expect(releaseWorkflow).toContain("confirm_publish requires workflow_dispatch on a tag ref");
  });

  it("binds publish to infinitypaul/aroko repository identity", () => {
    expect(releaseWorkflow).toContain('infinitypaul/aroko');
    expect(releaseWorkflow).toContain("1413375921");
    expect(releaseWorkflow).toContain("unexpected repository id");
  });

  it("verifies packed commit matches publish checkout and manifest", () => {
    expect(releaseWorkflow).toContain("checkout commit");
    expect(releaseWorkflow).toContain("manifest gitCommit");
    expect(releaseWorkflow).toContain("needs.release-pack.outputs.commit");
  });

  it("fail-closes on package name/version/bin mismatch", () => {
    expect(releaseWorkflow).toContain('@arokodev/cli');
    expect(releaseWorkflow).toContain("0.1.0-alpha.1");
    expect(releaseWorkflow).toContain("pairmesh bin");
    expect(publishCheck).toContain('@arokodev/cli');
    expect(packagePairmesh).toContain('PUBLIC_CLI_PACKAGE_NAME = "@arokodev/cli"');
    expect(updateConstants).toContain('CANONICAL_CLI_PACKAGE_NAME = "@arokodev/cli"');
  });

  it("rejects long-lived npm token env during publish", () => {
    expect(releaseWorkflow).toContain("long-lived npm token env must not be present");
    expect(releaseWorkflow).toContain("NPM_TOKEN");
    expect(releaseWorkflow).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./);
  });

  it("scopes id-token write to publish job only", () => {
    // Workflow-level permissions must not grant id-token: write.
    const beforeJobs = releaseWorkflow.split(/^jobs:/m)[0] ?? "";
    expect(beforeJobs).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(beforeJobs).not.toMatch(/id-token:\s*write/);
    expect(releaseWorkflow).toMatch(
      /release-publish:[\s\S]*permissions:[\s\S]*id-token:\s*write/
    );
  });

  it("uses artifact name keyed by packed tag not ambiguous ref_name", () => {
    expect(releaseWorkflow).toContain("aroko-release-${{ steps.tag.outputs.tag }}");
    expect(releaseWorkflow).toContain("aroko-release-${{ needs.release-pack.outputs.tag }}");
  });

  it("requires Node.js 22+ and npm >= 11.5.1 for trusted publishing", () => {
    expect(releaseWorkflow).toMatch(/node-version:\s*"22"/);
    expect(releaseWorkflow).toContain("npm install -g npm@^11.5.1");
    expect(releaseWorkflow).toContain("trusted publishing requires Node.js >= 22.14");
    expect(releaseWorkflow).toContain("trusted publishing requires npm >= 11.5.1");
    // Must not pin the release toolchain to Node 20 anymore.
    expect(releaseWorkflow).not.toMatch(/node-version:\s*"20"/);
  });
});

describe("S23-7J negative gate simulations", () => {
  function assertPublishIdentity(input: {
    repo: string;
    repoId: string;
    packedCommit: string;
    checkoutCommit: string;
    packedTag: string;
    headTag: string;
    packageName: string;
    packageVersion: string;
    manifestTag: string;
    manifestCommit: string;
    expectedSha: string;
    actualSha: string;
    confirmPublish: boolean;
    eventName: string;
    refType: string;
  }): { ok: boolean; reason?: string } {
    if (input.eventName !== "workflow_dispatch" || !input.confirmPublish) {
      return { ok: false, reason: "PUBLISH_NOT_AUTHORIZED" };
    }
    if (input.refType !== "tag") {
      return { ok: false, reason: "REF_NOT_TAG" };
    }
    if (input.repo !== "infinitypaul/aroko" || input.repoId !== "1413375921") {
      return { ok: false, reason: "WRONG_REPOSITORY" };
    }
    if (input.checkoutCommit !== input.packedCommit) {
      return { ok: false, reason: "COMMIT_MISMATCH" };
    }
    if (input.headTag !== input.packedTag || input.manifestTag !== input.packedTag) {
      return { ok: false, reason: "TAG_MISMATCH" };
    }
    if (input.manifestCommit !== input.packedCommit) {
      return { ok: false, reason: "MANIFEST_COMMIT_MISMATCH" };
    }
    if (input.packageName !== "@arokodev/cli" || input.packageVersion !== "0.1.0-alpha.1") {
      return { ok: false, reason: "PACKAGE_IDENTITY_MISMATCH" };
    }
    if (input.expectedSha !== input.actualSha) {
      return { ok: false, reason: "CHECKSUM_MISMATCH" };
    }
    return { ok: true };
  }

  const base = {
    repo: "infinitypaul/aroko",
    repoId: "1413375921",
    packedCommit: "97fa9c3e60849487cf5964b157abfe9d6023311a",
    checkoutCommit: "97fa9c3e60849487cf5964b157abfe9d6023311a",
    packedTag: "v0.1.0-alpha.1",
    headTag: "v0.1.0-alpha.1",
    packageName: "@arokodev/cli",
    packageVersion: "0.1.0-alpha.1",
    manifestTag: "v0.1.0-alpha.1",
    manifestCommit: "97fa9c3e60849487cf5964b157abfe9d6023311a",
    expectedSha: "abc",
    actualSha: "abc",
    confirmPublish: true,
    eventName: "workflow_dispatch",
    refType: "tag"
  };

  it("rejects confirm_publish=false", () => {
    expect(assertPublishIdentity({ ...base, confirmPublish: false }).reason).toBe(
      "PUBLISH_NOT_AUTHORIZED"
    );
  });

  it("rejects tag-push event for publish", () => {
    expect(assertPublishIdentity({ ...base, eventName: "push" }).reason).toBe(
      "PUBLISH_NOT_AUTHORIZED"
    );
  });

  it("rejects branch dispatch", () => {
    expect(assertPublishIdentity({ ...base, refType: "branch" }).reason).toBe("REF_NOT_TAG");
  });

  it("rejects wrong repository", () => {
    expect(assertPublishIdentity({ ...base, repo: "infinitypaul/aroko-internal" }).reason).toBe(
      "WRONG_REPOSITORY"
    );
  });

  it("rejects wrong package name", () => {
    expect(assertPublishIdentity({ ...base, packageName: "@aroko/cli" }).reason).toBe(
      "PACKAGE_IDENTITY_MISMATCH"
    );
  });

  it("rejects checksum mismatch", () => {
    expect(assertPublishIdentity({ ...base, actualSha: "deadbeef" }).reason).toBe(
      "CHECKSUM_MISMATCH"
    );
  });

  it("rejects commit mismatch", () => {
    expect(
      assertPublishIdentity({
        ...base,
        checkoutCommit: "0000000000000000000000000000000000000000"
      }).reason
    ).toBe("COMMIT_MISMATCH");
  });

  it("accepts fully aligned publish identity", () => {
    expect(assertPublishIdentity(base).ok).toBe(true);
  });
});
