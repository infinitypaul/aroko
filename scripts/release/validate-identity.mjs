#!/usr/bin/env node
/* eslint-env node */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALPHA_TAG_RE,
  ProvenanceError,
  assertAnnotatedTag,
  parseAlphaTag,
  readSourceIdentity
} from "./git-identity.mjs";

export function readPackageVersion(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")).version;
}

export function readProtocolVersion(repoRoot) {
  const text = readFileSync(join(repoRoot, "packages/protocol/src/version.ts"), "utf8");
  const m = text.match(/PAIRMESH_METADATA_VERSION\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new ProvenanceError("MISSING_PROTOCOL_VERSION", "PAIRMESH_METADATA_VERSION not found.");
  }
  return m[1];
}

export function readStateSchemaVersion(repoRoot) {
  const text = readFileSync(join(repoRoot, "packages/client/src/session/schemas.ts"), "utf8");
  const m = text.match(/LOCAL_STATE_VERSION\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new ProvenanceError("MISSING_STATE_SCHEMA_VERSION", "LOCAL_STATE_VERSION not found.");
  }
  return m[1];
}

/**
 * @param {'development' | 'release'} mode
 */
export function validateReleaseIdentity(repoRoot, mode = "development") {
  const packageVersion = readPackageVersion(repoRoot);
  const protocolVersion = readProtocolVersion(repoRoot);
  const stateSchemaVersion = readStateSchemaVersion(repoRoot);
  const identity = readSourceIdentity(repoRoot, {
    requireCanonicalRemote: mode === "release"
  });

  if (mode === "release") {
    if (identity.isDirty) {
      throw new ProvenanceError(
        "DIRTY_WORKING_TREE",
        "Release builds require a clean working tree (git status --porcelain empty)."
      );
    }
    if (!identity.gitTag) {
      throw new ProvenanceError(
        "MISSING_RELEASE_TAG",
        "Release builds require an annotated alpha tag pointing at HEAD (vX.Y.Z-alpha.N)."
      );
    }
    if (!ALPHA_TAG_RE.test(identity.gitTag)) {
      throw new ProvenanceError(
        "MALFORMED_RELEASE_TAG",
        `Release tag must match vX.Y.Z-alpha.N (got ${identity.gitTag}).`
      );
    }
    assertAnnotatedTag(repoRoot, identity.gitTag);
    const parsed = parseAlphaTag(identity.gitTag);
    if (!parsed || parsed.version !== packageVersion) {
      throw new ProvenanceError(
        "VERSION_TAG_MISMATCH",
        `Package version ${packageVersion} does not match release tag ${identity.gitTag}.`
      );
    }
    if (!identity.canonicalRemoteOk) {
      throw new ProvenanceError(
        "WRONG_CANONICAL_REMOTE",
        "Release builds require origin → infinitypaul/aroko-internal or infinitypaul/aroko."
      );
    }
  } else if (identity.gitTag && ALPHA_TAG_RE.test(identity.gitTag)) {
    const parsed = parseAlphaTag(identity.gitTag);
    if (parsed && parsed.version !== packageVersion) {
      // Even in development, warn via hard fail if tagged incorrectly — avoids false releases
      throw new ProvenanceError(
        "VERSION_TAG_MISMATCH",
        `Package version ${packageVersion} does not match tag at HEAD ${identity.gitTag}.`
      );
    }
  }

  const releaseId =
    mode === "release" && identity.gitTag
      ? `aroko-${packageVersion}-${identity.gitCommitShort}`
      : identity.gitTag && ALPHA_TAG_RE.test(identity.gitTag)
        ? `aroko-${packageVersion}-${identity.gitCommitShort}`
        : `dev-${identity.gitCommitShort}`;

  return {
    mode,
    product: "Aroko",
    productVersion: packageVersion,
    packageVersion,
    releaseId,
    gitCommit: identity.gitCommit,
    gitTag: identity.gitTag,
    isDirty: identity.isDirty,
    sourceTimestamp: identity.sourceTimestamp,
    protocolVersion,
    stateSchemaVersion,
    remoteUrl: identity.remoteUrl,
    repositoryRole: identity.repositoryRole,
        // canonicalSourceCommit / publicSourceCommit are filled by package-release when known.
    canonicalSourceCommit: null,
    publicSourceCommit: null
  };
}
