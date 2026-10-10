#!/usr/bin/env node
/* eslint-env node */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const stagingDir = join(repoRoot, "dist-packages/aroko-cli-staging");
const cliPackagePath = join(repoRoot, "apps/cli/package.json");

const REQUIRED_FIELDS = ["name", "version", "description", "bin", "engines", "files"];

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`  ok ${message}`);
}

async function main() {
  const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));
  console.log("npm publish readiness (dry-run, no publish)");

  for (const field of REQUIRED_FIELDS) {
    check(Boolean(cliPackage[field]), `package.json has ${field}`);
  }

  check(
    cliPackage.name === "@pairmesh/cli",
    "scoped package name @pairmesh/cli (workspace; public staging uses @arokodev/cli)"
  );
  check(cliPackage.version === "0.1.0-alpha.1", "pre-release version 0.1.0-alpha.1");
  check(cliPackage.bin?.aroko === "./dist/index.js", "aroko bin entry");
  check(cliPackage.bin?.pairmesh === "./dist/index.js", "pairmesh compatibility bin entry");
  check(cliPackage.engines?.node === ">=20.0.0", "engines.node >=20.0.0");
  check(
    Array.isArray(cliPackage.bundledDependencies) && cliPackage.bundledDependencies.length > 0,
    "bundledDependencies declared"
  );

  check(cliPackage.license === "Apache-2.0", "workspace package license is Apache-2.0");

  execSync("npm pack --dry-run", { cwd: stagingDir, stdio: "inherit" });

  const outputDir = join(repoRoot, "dist-packages");
  const tarballs = (await readdir(outputDir)).filter((name) => name.endsWith(".tgz")).sort();
  const tarball = join(outputDir, tarballs.at(-1) ?? "");
  const manifest = execSync(`tar -tzf ${JSON.stringify(tarball)}`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const banned = manifest.filter((entry) => {
    if (entry.includes("/.env") || entry.includes("/.pairmesh/") || entry.includes("/.cursor/")) {
      return true;
    }
    if (entry.includes("/fixtures/")) {
      return true;
    }
    // PairMesh dist tests only — transitive deps (e.g. zod) may ship their own test sources.
    return /^package\/dist\/.*\.test\./.test(entry);
  });
  check(banned.length === 0, "tarball excludes secrets, local state, fixtures, tests");

  const packedPackageJson = execSync(`tar -xOf ${JSON.stringify(tarball)} package/package.json`, {
    encoding: "utf8"
  });
  const packedPackage = JSON.parse(packedPackageJson);
  check(packedPackage.name === "@arokodev/cli", "packed name is @arokodev/cli");
  check(packedPackage.version === "0.1.0-alpha.1", "packed version is 0.1.0-alpha.1");
  check(packedPackage.bin?.aroko === "./dist/index.js", "packed aroko bin entry");
  check(packedPackage.bin?.pairmesh === "./dist/index.js", "packed pairmesh bin entry");
  check(
    !JSON.stringify(packedPackage.dependencies ?? {}).includes("file:"),
    "packed dependencies do not use file: paths"
  );
  check(
    !packedPackageJson.includes("/Users/") && !packedPackageJson.includes("/home/"),
    "packed package.json has no absolute home paths"
  );
  check(Boolean(packedPackage.repository?.url), "packed package.json has repository.url");
  check(packedPackage.license === "Apache-2.0", "packed package license is Apache-2.0");

  console.log("");
  console.log("Publish readiness checks passed (artifact not published).");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
