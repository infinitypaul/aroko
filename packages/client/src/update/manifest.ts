import { CANONICAL_CLI_PACKAGE_NAME } from "./constants.js";
import { parseSemver } from "./semver.js";
import type { TrustedChannelDocument, TrustedRelease } from "./types.js";

export class ChannelManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelManifestError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ChannelManifestError(`Release channel missing required field: ${field}`);
  }
  return value.trim();
}

function parseRelease(raw: unknown, index: number): TrustedRelease {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChannelManifestError(`Release entry ${index} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const version = requireString(r.version, `releases[${index}].version`);
  try {
    parseSemver(version);
  } catch {
    throw new ChannelManifestError(`Malformed version in releases[${index}]: ${version}`);
  }
  const artifactSha256 = requireString(
    r.artifactSha256,
    `releases[${index}].artifactSha256`
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) {
    throw new ChannelManifestError(`Invalid artifactSha256 in releases[${index}]`);
  }
  const gitCommit = requireString(r.gitCommit, `releases[${index}].gitCommit`).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new ChannelManifestError(`gitCommit must be 40-hex in releases[${index}]`);
  }
  const notes =
    r.notes === undefined ? undefined : requireString(r.notes, `releases[${index}].notes`);
  // Manifest must never carry install scripts — reject if present.
  if ("installScript" in r || "installCommand" in r || "postInstall" in r) {
    throw new ChannelManifestError("Release metadata must not include install scripts");
  }
  return {
    version,
    releaseId: requireString(r.releaseId, `releases[${index}].releaseId`),
    gitCommit,
    gitTag: requireString(r.gitTag, `releases[${index}].gitTag`),
    publishedAt: requireString(r.publishedAt, `releases[${index}].publishedAt`),
    artifactUrl: requireString(r.artifactUrl, `releases[${index}].artifactUrl`),
    artifactSha256,
    artifactName: requireString(r.artifactName, `releases[${index}].artifactName`),
    protocolVersion: requireString(r.protocolVersion, `releases[${index}].protocolVersion`),
    stateSchemaVersion: requireString(
      r.stateSchemaVersion,
      `releases[${index}].stateSchemaVersion`
    ),
    ...(notes ? { notes } : {})
  };
}

export function parseTrustedChannelDocument(raw: unknown): TrustedChannelDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChannelManifestError("Release channel document must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  const product = requireString(doc.product, "product");
  if (product !== "Aroko") {
    throw new ChannelManifestError(`Unexpected product: ${product}`);
  }
  const packageName = requireString(doc.packageName, "packageName");
  if (packageName !== CANONICAL_CLI_PACKAGE_NAME) {
    throw new ChannelManifestError(
      `Untrusted packageName ${packageName}; expected ${CANONICAL_CLI_PACKAGE_NAME}`
    );
  }
  if (!Array.isArray(doc.releases) || doc.releases.length === 0) {
    throw new ChannelManifestError("Release channel requires a non-empty releases array");
  }
  const releases = doc.releases.map((entry, i) => parseRelease(entry, i));
  const currentVersion = requireString(doc.currentVersion, "currentVersion");
  try {
    parseSemver(currentVersion);
  } catch {
    throw new ChannelManifestError(`Malformed currentVersion: ${currentVersion}`);
  }
  if (!releases.some((r) => r.version === currentVersion)) {
    throw new ChannelManifestError(`currentVersion ${currentVersion} not found in releases`);
  }
  const versions = new Set<string>();
  for (const release of releases) {
    if (versions.has(release.version)) {
      throw new ChannelManifestError(`Duplicate release version: ${release.version}`);
    }
    versions.add(release.version);
  }
  return { product, packageName, currentVersion, releases };
}

export function findReleaseByVersion(
  channel: TrustedChannelDocument,
  version: string
): TrustedRelease | undefined {
  return channel.releases.find((r) => r.version === version);
}

export function selectCurrentRelease(channel: TrustedChannelDocument): TrustedRelease {
  const found = findReleaseByVersion(channel, channel.currentVersion);
  if (!found) {
    throw new ChannelManifestError(
      `currentVersion ${channel.currentVersion} missing from releases`
    );
  }
  return found;
}
