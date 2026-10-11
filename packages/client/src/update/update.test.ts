import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_CLI_PACKAGE_NAME,
  channelFileUrl,
  compareSemver,
  downloadAndVerifyArtifact,
  evaluateUpdateCheck,
  executeInstallPlan,
  fetchTrustedChannel,
  findReleaseByVersion,
  isForbiddenPeerUpdateCapability,
  parseTrustedChannelDocument,
  planInstall,
  selectCurrentRelease,
  verifyLocalArtifact,
  type TrustedRelease
} from "./index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(): string {
  const dir = join(
    tmpdir(),
    `aroko-update-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function makeRelease(
  overrides: Partial<TrustedRelease> &
    Pick<TrustedRelease, "version" | "artifactUrl" | "artifactSha256" | "artifactName">
): TrustedRelease {
  return {
    releaseId: `aroko-${overrides.version}-aaaaaaaaaaaa`,
    gitCommit: "a".repeat(40),
    gitTag: `v${overrides.version}`,
    publishedAt: "2026-09-13T00:00:00.000Z",
    protocolVersion: "0.1.0",
    stateSchemaVersion: "0.6.0",
    notes: "test",
    ...overrides
  };
}

describe("semver compare", () => {
  it("orders alpha prereleases correctly", () => {
    expect(compareSemver("0.1.0-alpha.1", "0.1.0-alpha.2")).toBe(-1);
    expect(compareSemver("0.1.0-alpha.2", "0.1.0-alpha.1")).toBe(1);
    expect(compareSemver("0.1.0-alpha.1", "0.1.0-alpha.1")).toBe(0);
    expect(compareSemver("0.1.0", "0.1.0-alpha.2")).toBe(1);
  });

  it("rejects malformed versions", () => {
    expect(() => compareSemver("latest", "0.1.0")).toThrow(/Malformed/);
  });
});

describe("channel manifest", () => {
  it("accepts a valid channel document", () => {
    const release = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "aroko-cli-0.1.0-alpha.2.tgz",
      artifactUrl: "https://example.com/aroko-cli-0.1.0-alpha.2.tgz",
      artifactSha256: "b".repeat(64)
    });
    const doc = parseTrustedChannelDocument({
      product: "Aroko",
      packageName: CANONICAL_CLI_PACKAGE_NAME,
      currentVersion: "0.1.0-alpha.2",
      releases: [release]
    });
    expect(selectCurrentRelease(doc).version).toBe("0.1.0-alpha.2");
  });

  it("rejects wrong package name and install scripts", () => {
    expect(() =>
      parseTrustedChannelDocument({
        product: "Aroko",
        packageName: "@evil/cli",
        currentVersion: "0.1.0-alpha.1",
        releases: [
          makeRelease({
            version: "0.1.0-alpha.1",
            artifactName: "x.tgz",
            artifactUrl: "https://example.com/x.tgz",
            artifactSha256: "c".repeat(64)
          })
        ]
      })
    ).toThrow(/Untrusted packageName/);

    expect(() =>
      parseTrustedChannelDocument({
        product: "Aroko",
        packageName: CANONICAL_CLI_PACKAGE_NAME,
        currentVersion: "0.1.0-alpha.1",
        releases: [
          {
            ...makeRelease({
              version: "0.1.0-alpha.1",
              artifactName: "x.tgz",
              artifactUrl: "https://example.com/x.tgz",
              artifactSha256: "c".repeat(64)
            }),
            installScript: "curl|sh"
          }
        ]
      })
    ).toThrow(/install scripts/);
  });

  it("rejects missing checksum", () => {
    expect(() =>
      parseTrustedChannelDocument({
        product: "Aroko",
        packageName: CANONICAL_CLI_PACKAGE_NAME,
        currentVersion: "0.1.0-alpha.1",
        releases: [
          {
            version: "0.1.0-alpha.1",
            releaseId: "r",
            gitCommit: "a".repeat(40),
            gitTag: "v0.1.0-alpha.1",
            publishedAt: "2026-09-13T00:00:00.000Z",
            artifactUrl: "https://example.com/x.tgz",
            artifactName: "x.tgz",
            protocolVersion: "0.1.0",
            stateSchemaVersion: "0.6.0"
          }
        ]
      })
    ).toThrow(/artifactSha256/);
  });
});

describe("update check", () => {
  it("distinguishes up-to-date, available, and newer-than-channel", () => {
    const available = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "a.tgz",
      artifactUrl: "https://example.com/a.tgz",
      artifactSha256: "d".repeat(64)
    });
    expect(evaluateUpdateCheck({ installedVersion: "0.1.0-alpha.2", available }).status).toBe(
      "up-to-date"
    );
    expect(evaluateUpdateCheck({ installedVersion: "0.1.0-alpha.1", available }).status).toBe(
      "update-available"
    );
    expect(evaluateUpdateCheck({ installedVersion: "0.1.0-alpha.4", available }).status).toBe(
      "newer-than-channel"
    );
  });
});

describe("artifact verification", () => {
  it("verifies matching checksum and rejects mismatch", async () => {
    const dir = tempDir();
    const path = join(dir, "aroko-cli.tgz");
    const body = Buffer.from("fake-tarball-bytes");
    writeFileSync(path, body);
    const digest = sha256(body);
    const ok = await verifyLocalArtifact(path, digest);
    expect(ok.ok).toBe(true);
    const bad = await verifyLocalArtifact(path, "e".repeat(64));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toMatch(/checksum does not match/);
    }
  });

  it("downloads file:// artifact and verifies before return", async () => {
    const dir = tempDir();
    const path = join(dir, "pkg.tgz");
    const body = Buffer.from("download-me");
    writeFileSync(path, body);
    const digest = sha256(body);
    const release = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "pkg.tgz",
      artifactUrl: channelFileUrl(path),
      artifactSha256: digest
    });
    const result = await downloadAndVerifyArtifact({
      release,
      destinationDir: join(dir, "out")
    });
    expect(result.ok).toBe(true);
  });
});

describe("install planning and consent paths", () => {
  it("refuses silent downgrade without allowDowngrade", () => {
    const target = makeRelease({
      version: "0.1.0-alpha.1",
      artifactName: "a.tgz",
      artifactUrl: "https://example.com/a.tgz",
      artifactSha256: "f".repeat(64)
    });
    const refused = planInstall({
      installedVersion: "0.1.0-alpha.2",
      installedProtocolVersion: "0.1.0",
      installedStateSchemaVersion: "0.6.0",
      target,
      verifiedArtifactPath: "/tmp/a.tgz",
      allowDowngrade: false
    });
    expect(refused.ok).toBe(false);

    const allowed = planInstall({
      installedVersion: "0.1.0-alpha.2",
      installedProtocolVersion: "0.1.0",
      installedStateSchemaVersion: "0.6.0",
      target,
      verifiedArtifactPath: "/tmp/a.tgz",
      allowDowngrade: true
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.plan.isDowngrade).toBe(true);
    }
  });

  it("holds on older state schema", () => {
    const target = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "a.tgz",
      artifactUrl: "https://example.com/a.tgz",
      artifactSha256: "1".repeat(64),
      stateSchemaVersion: "0.5.0"
    });
    const result = planInstall({
      installedVersion: "0.1.0-alpha.1",
      installedProtocolVersion: "0.1.0",
      installedStateSchemaVersion: "0.6.0",
      target,
      verifiedArtifactPath: "/tmp/a.tgz",
      allowDowngrade: false
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/state schema/);
    }
  });

  it("does not report success when install executor fails", async () => {
    const target = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "a.tgz",
      artifactUrl: "https://example.com/a.tgz",
      artifactSha256: "2".repeat(64)
    });
    const planned = planInstall({
      installedVersion: "0.1.0-alpha.1",
      installedProtocolVersion: "0.1.0",
      installedStateSchemaVersion: "0.6.0",
      target,
      verifiedArtifactPath: "/tmp/a.tgz",
      allowDowngrade: false
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const outcome = await executeInstallPlan({
      plan: planned.plan,
      installExecutor: async () => {
        throw new Error("npm blew up");
      }
    });
    expect(outcome.ok).toBe(false);
  });

  it("verifies post-install version match", async () => {
    const target = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "a.tgz",
      artifactUrl: "https://example.com/a.tgz",
      artifactSha256: "3".repeat(64)
    });
    const planned = planInstall({
      installedVersion: "0.1.0-alpha.1",
      installedProtocolVersion: "0.1.0",
      installedStateSchemaVersion: "0.6.0",
      target,
      verifiedArtifactPath: "/tmp/a.tgz",
      allowDowngrade: false
    });
    if (!planned.ok) throw new Error("expected plan");
    const mismatch = await executeInstallPlan({
      plan: planned.plan,
      installExecutor: async () => undefined,
      versionProbe: async () => "0.1.0-alpha.1"
    });
    expect(mismatch.ok).toBe(false);
    const ok = await executeInstallPlan({
      plan: planned.plan,
      installExecutor: async () => undefined,
      versionProbe: async () => "0.1.0-alpha.2"
    });
    expect(ok.ok).toBe(true);
  });
});

describe("file channel fetch", () => {
  it("loads a fixture channel document", async () => {
    const dir = tempDir();
    const release = makeRelease({
      version: "0.1.0-alpha.2",
      artifactName: "a.tgz",
      artifactUrl: "https://example.com/a.tgz",
      artifactSha256: "4".repeat(64)
    });
    const channelPath = join(dir, "channel.json");
    writeFileSync(
      channelPath,
      JSON.stringify({
        product: "Aroko",
        packageName: CANONICAL_CLI_PACKAGE_NAME,
        currentVersion: "0.1.0-alpha.2",
        releases: [
          makeRelease({
            version: "0.1.0-alpha.1",
            artifactName: "old.tgz",
            artifactUrl: "https://example.com/old.tgz",
            artifactSha256: "5".repeat(64)
          }),
          release
        ]
      })
    );
    const channel = await fetchTrustedChannel({ url: channelFileUrl(channelPath) });
    expect(findReleaseByVersion(channel, "0.1.0-alpha.1")?.version).toBe("0.1.0-alpha.1");
    expect(selectCurrentRelease(channel).version).toBe("0.1.0-alpha.2");
  });
});

describe("peer update authority boundary", () => {
  it("flags forbidden update capability ids", () => {
    expect(isForbiddenPeerUpdateCapability("software.update")).toBe(true);
    expect(isForbiddenPeerUpdateCapability("aroko.update")).toBe(true);
    expect(isForbiddenPeerUpdateCapability("repository.inspect")).toBe(false);
  });
});
