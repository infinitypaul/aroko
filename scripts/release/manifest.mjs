#!/usr/bin/env node
/* eslint-env node */

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function readToolchain(repoRoot) {
  let pnpm = "unknown";
  try {
    pnpm = execFileSync("pnpm", ["-v"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const pm = String(pkg.packageManager ?? "");
    const m = pm.match(/pnpm@(.+)/);
    if (m) {
      pnpm = m[1];
    }
  }
  return {
    node: process.version,
    pnpm
  };
}

export function buildReleaseManifest(input) {
  const {
    product,
    version,
    releaseId,
    gitCommit,
    gitTag,
    builtAt,
    node,
    pnpm,
    protocolVersion,
    stateSchemaVersion,
    artifacts
  } = input;

  const required = {
    product,
    version,
    releaseId,
    gitCommit,
    gitTag,
    builtAt,
    node,
    pnpm,
    protocolVersion,
    stateSchemaVersion,
    artifacts
  };

  for (const [key, value] of Object.entries(required)) {
    if (value === undefined || value === null || value === "" || value === "unknown") {
      throw new Error(`Release manifest missing required field: ${key}`);
    }
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("Release manifest requires at least one artifact.");
  }
  for (const art of artifacts) {
    if (!art.name || !art.sha256 || typeof art.size !== "number") {
      throw new Error("Artifact entries require name, sha256, size.");
    }
    if (!/^[0-9a-f]{64}$/i.test(art.sha256)) {
      throw new Error(`Invalid artifact sha256 for ${art.name}`);
    }
  }

  return {
    product,
    version,
    releaseId,
    gitCommit,
    gitTag,
    builtAt,
    node,
    pnpm,
    protocolVersion,
    stateSchemaVersion,
    artifacts: artifacts.map((a) => ({
      name: a.name,
      sha256: a.sha256.toLowerCase(),
      size: a.size
    })),
        ...(input.canonicalSourceCommit ? { canonicalSourceCommit: input.canonicalSourceCommit } : {}),
    ...(input.publicSourceCommit ? { publicSourceCommit: input.publicSourceCommit } : {}),
    ...(input.repositoryRole ? { repositoryRole: input.repositoryRole } : {})
  };
}

export function writeReleaseManifest(filePath, manifest) {
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function artifactEntryFromFile(filePath) {
  const st = statSync(filePath);
  return {
    name: basename(filePath),
    sha256: sha256File(filePath),
    size: st.size
  };
}
