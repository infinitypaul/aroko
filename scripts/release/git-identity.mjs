#!/usr/bin/env node
/* eslint-env node */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const ENGINEERING_CANONICAL_REPO_SLUG = "infinitypaul/aroko-internal";
export const ENGINEERING_CANONICAL_REPO_HTTPS =
  "https://github.com/infinitypaul/aroko-internal.git";
export const PUBLIC_PRODUCT_REPO_SLUG = "infinitypaul/aroko";
export const PUBLIC_PRODUCT_REPO_HTTPS = "https://github.com/infinitypaul/aroko.git";
export const PUBLIC_CLEAN_RECOVERY_REPO_SLUG = "infinitypaul/aroko-public-clean";
/** Remotes accepted for release-mode packaging (engineering or public-candidate). */
export const ACCEPTED_RELEASE_REMOTE_SLUGS = [
  ENGINEERING_CANONICAL_REPO_SLUG,
  PUBLIC_PRODUCT_REPO_SLUG,
  PUBLIC_CLEAN_RECOVERY_REPO_SLUG
];
export const CANONICAL_REPO_HTTPS = ENGINEERING_CANONICAL_REPO_HTTPS;
export const CANONICAL_REPO_SLUG = ENGINEERING_CANONICAL_REPO_SLUG;
export const ALPHA_TAG_RE = /^v(\d+\.\d+\.\d+-alpha\.\d+)$/;

export class ProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProvenanceError";
    this.code = code;
  }
}

function git(repoRoot, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (allowFail) {
      return null;
    }
    const stderr = error?.stderr?.toString?.() ?? "";
    throw new ProvenanceError(
      "GIT_COMMAND_FAILED",
      `git ${args.join(" ")} failed: ${stderr || error.message}`
    );
  }
}

export function assertGitRepo(repoRoot) {
  if (
    !existsSync(join(repoRoot, ".git")) &&
    git(repoRoot, ["rev-parse", "--git-dir"], { allowFail: true }) == null
  ) {
    throw new ProvenanceError(
      "NO_GIT_REPOSITORY",
      "No Git repository — release provenance requires a real checkout."
    );
  }
  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (inside !== "true") {
    throw new ProvenanceError("NO_GIT_REPOSITORY", "Not inside a Git work tree.");
  }
}

export function readGitCommit(repoRoot) {
  assertGitRepo(repoRoot);
  const sha = git(repoRoot, ["rev-parse", "HEAD"], { allowFail: true });
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new ProvenanceError("UNRESOLVED_HEAD", "Unable to resolve HEAD commit SHA.");
  }
  return sha.toLowerCase();
}

export function readGitDirty(repoRoot) {
  assertGitRepo(repoRoot);
  const porcelain = git(repoRoot, ["status", "--porcelain"]);
  return porcelain.length > 0;
}

export function readGitCommitTimestamp(repoRoot) {
  assertGitRepo(repoRoot);
  const iso = git(repoRoot, ["show", "-s", "--format=%cI", "HEAD"]);
  if (!iso) {
    throw new ProvenanceError("MISSING_COMMIT_TIMESTAMP", "Unable to read commit timestamp.");
  }
  return iso;
}

export function readGitRemoteUrl(repoRoot) {
  assertGitRepo(repoRoot);
  return git(repoRoot, ["config", "--get", "remote.origin.url"], { allowFail: true });
}

export function normalizeRepoIdentity(urlOrSlug) {
  if (!urlOrSlug) {
    return null;
  }
  let s = String(urlOrSlug)
    .trim()
    .replace(/\.git$/i, "");
  s = s.replace(/^git\+/, "");
  const ssh = s.match(/^git@github\.com:(.+)$/i);
  if (ssh) {
    return ssh[1].toLowerCase();
  }
  const https = s.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (https) {
    return https[1].toLowerCase();
  }
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(s)) {
    return s.toLowerCase();
  }
  return s.toLowerCase();
}

export function assertCanonicalRemote(repoRoot, { required = false } = {}) {
  const remote = readGitRemoteUrl(repoRoot);
  const normalized = normalizeRepoIdentity(remote);
  if (!normalized) {
    if (required) {
      throw new ProvenanceError(
        "MISSING_CANONICAL_REMOTE",
        "origin remote is required for release builds."
      );
    }
    return { remote: null, ok: false, role: null };
  }
  if (!ACCEPTED_RELEASE_REMOTE_SLUGS.includes(normalized)) {
    throw new ProvenanceError(
      "WRONG_CANONICAL_REMOTE",
      `origin remote must be one of ${ACCEPTED_RELEASE_REMOTE_SLUGS.join(" | ")} (got ${remote}).`
    );
  }
  const role =
    normalized === PUBLIC_PRODUCT_REPO_SLUG || normalized === PUBLIC_CLEAN_RECOVERY_REPO_SLUG
      ? "public"
      : "engineering";
  return { remote, ok: true, role, slug: normalized };
}

/**
 * Exact tag pointing at HEAD (annotated preferred). Returns null if none.
 */
export function readExactHeadTag(repoRoot) {
  assertGitRepo(repoRoot);
  // Prefer annotated tags pointing exactly at HEAD
  const tags = git(repoRoot, ["tag", "--points-at", "HEAD"], { allowFail: true });
  if (!tags) {
    return null;
  }
  const list = tags
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  const alpha = list.filter((t) => ALPHA_TAG_RE.test(t));
  if (alpha.length === 1) {
    return alpha[0];
  }
  if (alpha.length > 1) {
    // Deterministic pick: sort
    return alpha.sort()[0];
  }
  return list.sort()[0] ?? null;
}

export function parseAlphaTag(tag) {
  const m = String(tag ?? "").match(ALPHA_TAG_RE);
  if (!m) {
    return null;
  }
  return { tag: m[0], version: m[1] };
}

/** Annotated tags are `tag` objects; lightweight tags resolve as `commit`. */
export function assertAnnotatedTag(repoRoot, tag) {
  assertGitRepo(repoRoot);
  const objectType = git(repoRoot, ["cat-file", "-t", tag], { allowFail: true });
  if (objectType !== "tag") {
    throw new ProvenanceError(
      "LIGHTWEIGHT_RELEASE_TAG",
      `Release tag ${tag} must be an annotated tag (got object type ${objectType ?? "missing"}).`
    );
  }
}

export function readSourceIdentity(repoRoot, { requireCanonicalRemote = false } = {}) {
  const gitCommit = readGitCommit(repoRoot);
  const isDirty = readGitDirty(repoRoot);
  const sourceTimestamp = readGitCommitTimestamp(repoRoot);
  const gitTag = readExactHeadTag(repoRoot);
  const remoteInfo = assertCanonicalRemote(repoRoot, { required: requireCanonicalRemote });
  return {
    gitCommit,
    gitCommitShort: gitCommit.slice(0, 12),
    gitTag,
    isDirty,
    sourceTimestamp,
    remoteUrl: remoteInfo.remote,
    canonicalRemoteOk: remoteInfo.ok,
    repositoryRole: remoteInfo.role ?? null,
    remoteSlug: remoteInfo.slug ?? null
  };
}
