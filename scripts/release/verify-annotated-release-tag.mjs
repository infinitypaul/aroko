#!/usr/bin/env node
/**
 * S23-7Q — Fail-closed annotated release-tag verification.
 *
 * actions/checkout@v4 can overwrite refs/tags/<name> with the peeled commit
 * SHA after first fetching the annotated tag object. Callers should set
 * fetchAnnotatedTag=true in CI to restore the annotated object from origin,
 * then verify using the full refs/tags/<name> ref.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALPHA_TAG_RE = /^v\d+\.\d+\.\d+-alpha\.\d+$/;

/**
 * @typedef {object} VerifyAnnotatedReleaseTagInput
 * @property {string} repoRoot
 * @property {string} repository
 * @property {string|number} repositoryId
 * @property {string} githubRef
 * @property {string} githubRefType
 * @property {string} [githubRefName]
 * @property {string} [expectedRepo]
 * @property {string} [expectedRepoId]
 * @property {boolean} [fetchAnnotatedTag]
 * @property {(args: string[], opts?: { cwd?: string }) => string} [runGit]
 */

/**
 * @typedef {object} VerifyAnnotatedReleaseTagResult
 * @property {string} tagName
 * @property {string} tagRef
 * @property {string} tagObject
 * @property {string} peeledCommit
 * @property {string} headCommit
 */

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 */
export function defaultRunGit(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

/**
 * @param {VerifyAnnotatedReleaseTagInput} input
 * @returns {VerifyAnnotatedReleaseTagResult}
 */
export function verifyAnnotatedReleaseTag(input) {
  const expectedRepo = input.expectedRepo ?? "infinitypaul/aroko";
  const expectedRepoId = String(input.expectedRepoId ?? "1413375921");
  const runGit = input.runGit ?? defaultRunGit;
  const cwd = resolve(input.repoRoot);

  if (!existsSync(cwd)) {
    throw new Error(`FAIL: repoRoot does not exist: ${cwd}`);
  }

  if (String(input.repository) !== expectedRepo) {
    throw new Error(
      `FAIL: release workflow must run on ${expectedRepo} (got ${input.repository})`
    );
  }
  if (String(input.repositoryId) !== expectedRepoId) {
    throw new Error(`FAIL: unexpected repository id ${input.repositoryId}`);
  }

  if (input.githubRefType !== "tag") {
    throw new Error(
      `FAIL: release pack requires a tag ref (got ref_type=${input.githubRefType} ref=${input.githubRef})`
    );
  }
  if (!String(input.githubRef).startsWith("refs/tags/")) {
    throw new Error(`FAIL: github.ref must be refs/tags/<name> (got ${input.githubRef})`);
  }

  const tagName = String(input.githubRef).slice("refs/tags/".length);
  if (input.githubRefName && input.githubRefName !== tagName) {
    throw new Error(
      `FAIL: github.ref_name ${input.githubRefName} does not match tag ${tagName}`
    );
  }
  if (!ALPHA_TAG_RE.test(tagName)) {
    throw new Error(`FAIL: release tag must match vX.Y.Z-alpha.N (got ${tagName})`);
  }

  const tagRef = `refs/tags/${tagName}`;

  if (input.fetchAnnotatedTag) {
    // Restore annotated tag object if actions/checkout replaced the ref with a commit.
    runGit(["fetch", "origin", `${tagRef}:${tagRef}`, "--force"], { cwd });
  }

  let tagObject;
  try {
    tagObject = runGit(["rev-parse", tagRef], { cwd });
  } catch {
    throw new Error(`FAIL: missing tag ref ${tagRef}`);
  }

  let objectType;
  try {
    objectType = runGit(["cat-file", "-t", tagObject], { cwd });
  } catch {
    throw new Error(`FAIL: tag object ${tagObject} for ${tagRef} is not present`);
  }
  if (objectType !== "tag") {
    throw new Error(
      `FAIL: ${tagRef} must resolve to an annotated tag object (got type ${objectType} at ${tagObject})`
    );
  }

  const peeledCommit = runGit(["rev-parse", `${tagRef}^{}`], { cwd });
  const headCommit = runGit(["rev-parse", "HEAD"], { cwd });
  if (peeledCommit !== headCommit) {
    throw new Error(
      `FAIL: annotated tag ${tagName} peels to ${peeledCommit} but HEAD is ${headCommit}`
    );
  }

  const porcelain = runGit(["status", "--porcelain"], { cwd });
  if (porcelain) {
    throw new Error("FAIL: working tree must be clean");
  }

  return {
    tagName,
    tagRef,
    tagObject,
    peeledCommit,
    headCommit
  };
}

/**
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const result = verifyAnnotatedReleaseTag({
    repoRoot: args["repo-root"] ?? env.GITHUB_WORKSPACE ?? process.cwd(),
    repository: args.repository ?? env.GITHUB_REPOSITORY ?? "",
    repositoryId: args["repository-id"] ?? env.GITHUB_REPOSITORY_ID ?? "",
    githubRef: args.ref ?? env.GITHUB_REF ?? "",
    githubRefType: args["ref-type"] ?? env.GITHUB_REF_TYPE ?? "",
    githubRefName: args["ref-name"] ?? env.GITHUB_REF_NAME,
    fetchAnnotatedTag: args["fetch-annotated-tag"] === "true"
  });
  console.log(`tag=${result.tagName}`);
  console.log(`tag_object=${result.tagObject}`);
  console.log(`commit=${result.peeledCommit}`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `tag=${result.tagName}\ncommit=${result.peeledCommit}\ntag_object=${result.tagObject}\n`
    );
  }
  return result;
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
