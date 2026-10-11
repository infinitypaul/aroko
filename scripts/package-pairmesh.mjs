#!/usr/bin/env node
/* eslint-env node */
import { execSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackagingNpmEnv } from "./release/npm-pack-env.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repoRoot, "dist-packages");
const tarballDir = join(outputDir, "tarballs");
const stagingDir = join(outputDir, "aroko-cli-staging");

/** Public npm identity for the publishable CLI artifact (workspace remains @pairmesh/cli). */
export const PUBLIC_CLI_PACKAGE_NAME = "@arokodev/cli";
/** Stable release artifact filename prefix (product brand; independent of npm scope). */
export const PUBLIC_CLI_TARBALL_PREFIX = "aroko-cli";

const PACKAGE_VERSION = readCliPackageVersion();

/**
 * Workspace packages packed as file: inputs for staging.
 * `@pairmesh/cli` is intentionally omitted: the public artifact is produced from
 * `aroko-cli-staging` as `@arokodev/cli`. Packing the workspace CLI (bundledDependencies)
 * under CI setup-node auth/userconfig crashed npm 11 with "Exit handler never called!".
 */
const PACK_ORDER = [
  { name: "@pairmesh/protocol", dir: "packages/protocol" },
  { name: "@pairmesh/shared", dir: "packages/shared" },
  { name: "@pairmesh/permissions", dir: "packages/permissions" },
  { name: "@pairmesh/client", dir: "packages/client" },
  { name: "@pairmesh/coordination", dir: "apps/coordination" },
  { name: "@pairmesh/mcp", dir: "apps/mcp" }
];

/** @param {string} command @param {import("node:child_process").ExecSyncOptionsWithStringEncoding} [options] */
function runNpm(command, options = {}) {
  return execSync(command, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
    env: buildPackagingNpmEnv(options.env ?? process.env)
  });
}
const BANNED_TARBALL_PATTERNS = [
  /^package\/\.pairmesh\//,
  /^package\/\.cursor\//,
  /^package\/src\//,
  /^package\/fixtures\//,
  /^package\/dist\/.*\.test\./,
  /^package\/coverage\//
];

function readCliPackageVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")).version;
}

function run(command, options = {}) {
  execSync(command, { cwd: repoRoot, stdio: "inherit", ...options });
}

async function removeTestArtifacts(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await removeTestArtifacts(fullPath);
      continue;
    }
    if (
      entry.name.endsWith(".test.js") ||
      entry.name.endsWith(".test.js.map") ||
      entry.name.endsWith(".test.d.ts") ||
      entry.name.endsWith(".test.d.ts.map") ||
      entry.name.startsWith("test-helpers.")
    ) {
      await rm(fullPath, { force: true });
    }
  }
}

async function packWorkspacePackages() {
  await mkdir(tarballDir, { recursive: true });
  const packed = new Map();

  for (const pkg of PACK_ORDER) {
    const absDir = join(repoRoot, pkg.dir);
    await removeTestArtifacts(join(absDir, "dist"));

    const packageJsonPath = join(absDir, "package.json");
    const originalPackageJson = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(originalPackageJson);
    parsed.version = PACKAGE_VERSION;
    if (parsed.dependencies) {
      for (const [depName, depVersion] of Object.entries(parsed.dependencies)) {
        if (depVersion === "workspace:*") {
          parsed.dependencies[depName] = PACKAGE_VERSION;
        }
      }
    }
    await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    try {
      // Absolute destination avoids cwd-relative confusion across apps/* vs packages/*.
      const output = runNpm(`npm pack --pack-destination ${JSON.stringify(tarballDir)}`, {
        cwd: absDir
      }).trim();
      const tarballName = output.split("\n").pop()?.trim();
      if (!tarballName) {
        throw new Error(`npm pack did not return tarball for ${pkg.name}`);
      }
      packed.set(pkg.name, join(tarballDir, tarballName));
    } finally {
      await writeFile(packageJsonPath, originalPackageJson, "utf8");
    }
  }

  return packed;
}

async function createStagingInstall(packed) {
  rmSync(stagingDir, { recursive: true, force: true });
  await cp(join(repoRoot, "apps/cli/dist"), join(stagingDir, "dist"), { recursive: true });
  await removeTestArtifacts(stagingDir);

  const cliPackage = JSON.parse(await readFile(join(repoRoot, "apps/cli/package.json"), "utf8"));
  const dependencies = {};
  for (const [name, tarballPath] of packed.entries()) {
    if (name === "@pairmesh/cli") {
      continue;
    }
    dependencies[name] = `file:${tarballPath}`;
  }

  const depNames = Object.keys(dependencies);
  // Install uses file: tarballs so npm can bundle workspace packages locally.
  const installPackage = {
    name: PUBLIC_CLI_PACKAGE_NAME,
    version: PACKAGE_VERSION,
    description: cliPackage.description,
    license: cliPackage.license ?? "Apache-2.0",
    type: "module",
    engines: { node: ">=20.0.0" },
    bin: {
      aroko: "./dist/index.js",
      pairmesh: "./dist/index.js"
    },
    main: "./dist/index.js",
    files: ["dist", "LICENSE"],
    bundledDependencies: depNames,
    dependencies
  };

  await writeFile(
    join(stagingDir, "package.json"),
    `${JSON.stringify(installPackage, null, 2)}\n`,
    "utf8"
  );
  await cp(join(repoRoot, "LICENSE"), join(stagingDir, "LICENSE"));
  runNpm("npm install --omit=dev", { cwd: stagingDir, stdio: "inherit" });

  // Public/packaged package.json must not embed absolute local file: paths.
  const publishDependencies = Object.fromEntries(depNames.map((name) => [name, PACKAGE_VERSION]));
  const publishPackage = {
    ...installPackage,
    dependencies: publishDependencies,
    repository: {
      type: "git",
      url: "git+https://github.com/infinitypaul/aroko.git"
    },
    homepage: "https://github.com/infinitypaul/aroko",
    bugs: {
      url: "https://github.com/infinitypaul/aroko/issues"
    }
  };
  await writeFile(
    join(stagingDir, "package.json"),
    `${JSON.stringify(publishPackage, null, 2)}\n`,
    "utf8"
  );
}

async function inspectTarball(tarballPath) {
  const manifestPath = join(outputDir, "aroko-cli-contents.txt");
  run(`tar -tzf ${JSON.stringify(tarballPath)} > ${JSON.stringify(manifestPath)}`);
  const entries = readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
  const banned = entries.filter((entry) =>
    BANNED_TARBALL_PATTERNS.some((pattern) => pattern.test(entry))
  );
  if (banned.length > 0) {
    throw new Error(`Tarball contains banned paths:\n${banned.slice(0, 10).join("\n")}`);
  }

  console.log("");
  console.log("Tarball inspection");
  console.log(`  file: ${basename(tarballPath)}`);
  console.log(`  entries: ${entries.length}`);
  console.log(`  size: ${(statSync(tarballPath).size / 1024 / 1024).toFixed(2)} MB`);
}

async function main() {
  const argv = process.argv.slice(2);
  const skipGenerate = argv.includes("--skip-generate");
  const skipBuild = argv.includes("--skip-build");

  await mkdir(outputDir, { recursive: true });
  if (!skipGenerate) {
    console.log("Generating build identifier...");
    run("node scripts/generate-build-info.mjs");
  }
  if (!skipBuild) {
    console.log("Building Aroko packages...");
    // Avoid double generate when pnpm build would re-run generate-build-info
    if (skipGenerate) {
      run("pnpm -r --filter './apps/*' --filter './packages/*' run build");
    } else {
      run("pnpm build");
    }
  }

  console.log("Packing workspace packages...");
  const packed = await packWorkspacePackages();

  console.log("Creating staging install...");
  await createStagingInstall(packed);

  console.log("Creating distributable tarball...");
  const packOutput = runNpm(`npm pack --pack-destination ${JSON.stringify(outputDir)}`, {
    cwd: stagingDir
  }).trim();
  const tarballName = packOutput.split("\n").pop()?.trim();
  if (!tarballName) {
    throw new Error("npm pack did not report tarball name.");
  }

  const expectedTarballName = `${PUBLIC_CLI_TARBALL_PREFIX}-${PACKAGE_VERSION}.tgz`;
  let finalTarballName = tarballName;
  if (tarballName !== expectedTarballName) {
    renameSync(join(outputDir, tarballName), join(outputDir, expectedTarballName));
    finalTarballName = expectedTarballName;
  }

  const tarballPath = join(outputDir, finalTarballName);
  await inspectTarball(tarballPath);

  console.log("");
  console.log("Aroko package ready:");
  console.log(`  staging: dist-packages/aroko-cli-staging`);
  console.log(`  npm name: ${PUBLIC_CLI_PACKAGE_NAME}`);
  console.log(`  tarball: dist-packages/${finalTarballName}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
