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

  it("requires tag ref for every release-pack path", () => {
    expect(releaseWorkflow).toContain("github.ref_type");
    expect(releaseWorkflow).toContain("release pack requires workflow run on a tag ref");
    expect(releaseWorkflow).toMatch(/github\.ref_type\s*==\s*'tag'/);
  });

  it("binds publish to infinitypaul/aroko repository identity", () => {
    expect(releaseWorkflow).toContain("infinitypaul/aroko");
    expect(releaseWorkflow).toContain("1413375921");
    expect(releaseWorkflow).toContain("unexpected repository id");
  });

  it("verifies packed commit matches publish checkout and manifest", () => {
    expect(releaseWorkflow).toContain("checkout commit");
    expect(releaseWorkflow).toContain("manifest gitCommit");
    expect(releaseWorkflow).toContain("needs.release-pack.outputs.commit");
  });

  it("fail-closes on package name/version/bin mismatch", () => {
    expect(releaseWorkflow).toContain("@arokodev/cli");
    expect(releaseWorkflow).toContain('EXPECTED_VERSION="${TAG#v}"');
    expect(releaseWorkflow).toContain("packed package version must match tag");
    expect(releaseWorkflow).toContain("pairmesh bin");
    expect(publishCheck).toContain("@arokodev/cli");
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
    expect(releaseWorkflow).toMatch(/release-publish:[\s\S]*permissions:[\s\S]*id-token:\s*write/);
  });

  it("uses artifact name keyed by packed tag not ambiguous ref_name", () => {
    expect(releaseWorkflow).toContain("aroko-release-${{ steps.tag.outputs.tag }}");
    expect(releaseWorkflow).toContain("aroko-release-${{ needs.release-pack.outputs.tag }}");
  });

  it("requires Node.js 22+ and npm >= 11.15.0 for staged trusted publishing", () => {
    expect(releaseWorkflow).toMatch(/node-version:\s*"22"/);
    expect(releaseWorkflow).toContain("npm install -g npm@^11.15.0");
    expect(releaseWorkflow).toContain("trusted publishing requires Node.js >= 22.14");
    expect(releaseWorkflow).toContain("staged publishing requires npm >= 11.15.0");
    // Must not pin the release toolchain to Node 20 anymore.
    expect(releaseWorkflow).not.toMatch(/node-version:\s*"20"/);
  });

  it("stages with explicit alpha tag and never direct-publishes from CI", () => {
    expect(releaseWorkflow).toContain('npm stage publish "$TGZ" --access public --tag alpha');
    expect(releaseWorkflow).toContain("--tag alpha");
    // Direct registry publish must not appear as the CI publish action.
    expect(releaseWorkflow).not.toMatch(/npm publish ["']?\$TGZ/);
    expect(releaseWorkflow).not.toMatch(/npm publish .*--tag latest/);
  });

  it("gates GitHub Release separately from npm staging", () => {
    expect(releaseWorkflow).toContain("confirm_github_release");
    expect(releaseWorkflow).toMatch(/confirm_publish:[\s\S]*does NOT create a GitHub Release/);
    expect(releaseWorkflow).toMatch(
      /Create GitHub Release from same artifacts[\s\S]*if:\s*\$\{\{\s*inputs\.confirm_github_release\s*==\s*true\s*\}\}/
    );
    // npm stage step must not be gated behind confirm_github_release
    const stageIdx = releaseWorkflow.indexOf("npm stage publish");
    const releaseStepIdx = releaseWorkflow.indexOf("Create GitHub Release from same artifacts");
    expect(stageIdx).toBeGreaterThan(-1);
    expect(releaseStepIdx).toBeGreaterThan(stageIdx);
    const stageBlock = releaseWorkflow.slice(stageIdx - 400, stageIdx);
    expect(stageBlock).not.toContain("confirm_github_release");
  });

  it("restores and verifies annotated tag via full refs/tags ref (S23-7Q)", () => {
    expect(releaseWorkflow).toContain("verify-annotated-release-tag.mjs");
    expect(releaseWorkflow).toContain("--fetch-annotated-tag true");
    expect(releaseWorkflow).toContain("ref: ${{ github.ref }}");
    expect(releaseWorkflow).toContain("release pack requires workflow run on a tag ref");
    // Must not rely solely on short-name cat-file of describe output.
    expect(releaseWorkflow).not.toMatch(/OBJECT_TYPE=\$\(git cat-file -t "\$TAG"\)/);
  });
  it("removes setup-node .npmrc before package:release and keeps dirty-tree fail-closed (S23-7S)", () => {
    expect(releaseWorkflow).toContain("rm -f .npmrc");
    expect(releaseWorkflow).toContain("rm -rf docs/validation");
    expect(releaseWorkflow).toContain("working tree dirty before package:release");
    // Cleanup must sit in the pack job package step, not disable provenance.
    const packIdx = releaseWorkflow.indexOf("Package once (release mode)");
    const publishIdx = releaseWorkflow.indexOf("release-publish:");
    expect(packIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(packIdx);
    const packBlock = releaseWorkflow.slice(packIdx, publishIdx);
    expect(packBlock).toContain("rm -f .npmrc");
    expect(packBlock).toContain("pnpm run package:release");
    // Publish job must retain setup-node registry-url (OIDC/npmrc for stage path).
    const publishBlock = releaseWorkflow.slice(publishIdx);
    expect(publishBlock).toContain('registry-url: "https://registry.npmjs.org"');
    // Must not strip .npmrc from the publish job before npm stage publish.
    const stageIdx = publishBlock.indexOf("npm stage publish");
    expect(stageIdx).toBeGreaterThan(-1);
    const beforeStage = publishBlock.slice(0, stageIdx);
    expect(beforeStage).not.toContain("rm -f .npmrc");
  });

  it("keeps registry-url / auth off the nonpublishing release-pack job (S23-7U)", () => {
    const packJobIdx = releaseWorkflow.indexOf("release-pack:");
    const publishIdx = releaseWorkflow.indexOf("release-publish:");
    expect(packJobIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(packJobIdx);
    const packJob = releaseWorkflow.slice(packJobIdx, publishIdx);
    // Pack must not inject setup-node registry auth into npm pack.
    expect(packJob).not.toContain('registry-url: "https://registry.npmjs.org"');
    expect(packJob).toContain("release-pack must not receive npm auth tokens");
    // Publish retains registry-url for staged trusted publishing only.
    const publishJob = releaseWorkflow.slice(publishIdx);
    expect(publishJob).toContain('registry-url: "https://registry.npmjs.org"');
    // Packaging script must sanitize npm subprocess env.
    expect(packagePairmesh).toContain("buildPackagingNpmEnv");
    expect(packagePairmesh).toContain("npm-pack-env.mjs");
    // Workspace CLI pack with bundledDependencies is skipped (staging builds @arokodev/cli).
    expect(packagePairmesh).toContain("@pairmesh/cli` is intentionally omitted");
    expect(packagePairmesh).not.toContain('{ name: "@pairmesh/cli", dir: "apps/cli" }');
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
    const expectedVersion = input.packedTag.startsWith("v")
      ? input.packedTag.slice(1)
      : input.packedTag;
    if (input.packageName !== "@arokodev/cli" || input.packageVersion !== expectedVersion) {
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
    packedTag: "v0.1.0-alpha.4",
    headTag: "v0.1.0-alpha.4",
    packageName: "@arokodev/cli",
    packageVersion: "0.1.0-alpha.4",
    manifestTag: "v0.1.0-alpha.4",
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
