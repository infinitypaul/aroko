#!/usr/bin/env node
/* eslint-env node */

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseIdentity } from "./release/validate-identity.mjs";
import {
  artifactEntryFromFile,
  buildReleaseManifest,
  readToolchain,
  sha256File,
  writeReleaseManifest
} from "./release/manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repoRoot, "dist-packages");

function resolveDualRepoProvenance(identity) {
  /** @type {{ canonicalSourceCommit?: string, publicSourceCommit?: string, repositoryRole?: string }} */
  const dual = {
    repositoryRole: identity.repositoryRole ?? undefined
  };
  const exportMetaPath = join(repoRoot, "public-export.json");
  if (existsSync(exportMetaPath)) {
    const pe = JSON.parse(readFileSync(exportMetaPath, "utf8"));
    if (pe.privateSourceCommit) {
      dual.canonicalSourceCommit = pe.privateSourceCommit;
    }
    dual.publicSourceCommit = identity.gitCommit;
    dual.repositoryRole = dual.repositoryRole ?? "public";
  } else if (identity.repositoryRole === "engineering") {
    dual.canonicalSourceCommit = identity.gitCommit;
  } else if (identity.repositoryRole === "public") {
    dual.publicSourceCommit = identity.gitCommit;
  }
  return dual;
}

function run(command, options = {}) {
  execSync(command, { cwd: repoRoot, stdio: "inherit", ...options });
}

function main() {
  process.env.AROKO_RELEASE_MODE = "release";
  process.env.PAIRMESH_RELEASE_MODE = "release";

  console.log("Validating release identity...");
  const identity = validateReleaseIdentity(repoRoot, "release");
  const toolchain = readToolchain(repoRoot);

  const releaseDir = join(outputRoot, "releases", identity.releaseId);
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  writeFileSync(
    join(releaseDir, "RELEASE_LOCK.json"),
    `${JSON.stringify(
      {
        releaseId: identity.releaseId,
        gitCommit: identity.gitCommit,
        gitTag: identity.gitTag,
        packageVersion: identity.packageVersion,
        createdBy: "scripts/package-release.mjs"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log("Generating release build-info...");
  run("node scripts/generate-build-info.mjs");

  console.log("Building packages...");
  run("pnpm -r --filter './apps/*' --filter './packages/*' run build");

  console.log("Packing CLI (single artifact)...");
  run("node scripts/package-pairmesh.mjs --skip-generate --skip-build");

  const tarballName = `aroko-cli-${identity.packageVersion}.tgz`;
  const sourceTarball = join(outputRoot, tarballName);
  if (!existsSync(sourceTarball)) {
    throw new Error(`Expected tarball missing: ${sourceTarball}`);
  }

  const destTarball = join(releaseDir, tarballName);
  copyFileSync(sourceTarball, destTarball);
  const artifact = artifactEntryFromFile(destTarball);
  const dual = resolveDualRepoProvenance(identity);

  const manifest = buildReleaseManifest({
    product: identity.product,
    version: identity.packageVersion,
    releaseId: identity.releaseId,
    gitCommit: identity.gitCommit,
    gitTag: identity.gitTag,
    builtAt: identity.sourceTimestamp,
    node: toolchain.node,
    pnpm: toolchain.pnpm,
    protocolVersion: identity.protocolVersion,
    stateSchemaVersion: identity.stateSchemaVersion,
    artifacts: [artifact],
    ...dual
  });

  writeReleaseManifest(join(releaseDir, "release-manifest.json"), manifest);
  writeFileSync(
    join(releaseDir, `${tarballName}.sha256`),
    `${artifact.sha256}  ${tarballName}\n`,
    "utf8"
  );
  writeFileSync(
    join(releaseDir, "provenance.json"),
    `${JSON.stringify({ ...manifest, artifactSha256: artifact.sha256 }, null, 2)}\n`,
    "utf8"
  );

  if (sha256File(destTarball) !== artifact.sha256) {
    throw new Error("Checksum verification failed after write.");
  }

  console.log("");
  console.log("Release artifact ready (NOT published):");
  console.log(`  directory: dist-packages/releases/${identity.releaseId}/`);
  console.log(`  tarball:   ${tarballName}`);
  console.log(`  sha256:    ${artifact.sha256}`);
  console.log(`  size:      ${artifact.size}`);
  console.log(`  commit:    ${identity.gitCommit}`);
  console.log(`  tag:       ${identity.gitTag}`);
  console.log(`  manifest:  release-manifest.json`);
}

try {
  main();
} catch (error) {
  const code = error?.code ? `PROVENANCE_${error.code}: ` : "";
  console.error(`${code}${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
