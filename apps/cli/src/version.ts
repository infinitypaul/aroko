import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AROKO_BUILD_ID,
  AROKO_BUILD_TIMESTAMP,
  AROKO_BUILD_MODE,
  AROKO_GIT_COMMIT,
  AROKO_GIT_TAG,
  AROKO_IS_DIRTY,
  AROKO_PROTOCOL_VERSION,
  AROKO_RELEASE_ID,
  AROKO_STATE_SCHEMA_VERSION,
  AROKO_VERSION,
  type ArokoBuildInfo
} from "@pairmesh/client";

export function readCliVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  return pkg.version;
}

function readEmbeddedArtifactSha256(): string | undefined {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "provenance.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "provenance.json")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { artifactSha256?: string };
      if (typeof raw.artifactSha256 === "string" && /^[0-9a-f]{64}$/i.test(raw.artifactSha256)) {
        return raw.artifactSha256.toLowerCase();
      }
    } catch {
      // ignore malformed sidecar
    }
  }
  return undefined;
}

export function readArokoBuildInfo(): ArokoBuildInfo {
  const artifactSha256 = readEmbeddedArtifactSha256();
  return {
    product: "Aroko",
    version: AROKO_VERSION,
    productVersion: AROKO_VERSION,
    packageVersion: AROKO_VERSION,
    buildId: AROKO_BUILD_ID,
    buildTimestamp: AROKO_BUILD_TIMESTAMP,
    releaseId: AROKO_RELEASE_ID,
    gitCommit: AROKO_GIT_COMMIT,
    gitTag: AROKO_GIT_TAG || undefined,
    protocolVersion: AROKO_PROTOCOL_VERSION,
    stateSchemaVersion: AROKO_STATE_SCHEMA_VERSION,
    isDirty: AROKO_IS_DIRTY,
    buildMode: AROKO_BUILD_MODE,
    nodeVersion: process.version,
    ...(artifactSha256 ? { artifactSha256 } : {})
  };
}

/** @deprecated Prefer readArokoBuildInfo */
export function readPairMeshBuildInfo(): ArokoBuildInfo {
  return readArokoBuildInfo();
}

export const MIN_NODE_MAJOR = 20;

export function assertSupportedNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      [
        `Aroko requires Node.js ${MIN_NODE_MAJOR} or newer.`,
        `Detected: ${process.versions.node}`,
        `Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org or switch with nvm/fnm/volta.`
      ].join("\n")
    );
  }
}
