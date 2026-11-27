#!/usr/bin/env node
/* eslint-env node */

/**
 * @param {string} workflowYaml
 * @returns {{ ok: true, publishJob: string, packJob: string } | { ok: false, reason: string }}
 */
export function assertOidcPublishWorkflow(workflowYaml) {
  const text = String(workflowYaml ?? "");
  const publishIdx = text.indexOf("\n  release-publish:");
  const packIdx = text.indexOf("\n  release-pack:");
  if (packIdx < 0) {
    return { ok: false, reason: "MISSING_RELEASE_PACK_JOB" };
  }
  if (publishIdx < 0) {
    return { ok: false, reason: "MISSING_RELEASE_PUBLISH_JOB" };
  }

  const packJob = text.slice(packIdx, publishIdx);
  const publishJob = text.slice(publishIdx);

  if (!/environment:\s*production-release/.test(publishJob)) {
    return { ok: false, reason: "MISSING_PRODUCTION_RELEASE_ENVIRONMENT" };
  }
  if (!/id-token:\s*write/.test(publishJob)) {
    return { ok: false, reason: "MISSING_ID_TOKEN_WRITE" };
  }
  if (!/npm stage publish "\$TGZ" --access public --tag alpha/.test(publishJob)) {
    return { ok: false, reason: "MISSING_STAGE_ONLY_PUBLISH" };
  }
  if (/npm publish\b/.test(publishJob) && !/npm stage publish\b/.test(publishJob)) {
    return { ok: false, reason: "DIRECT_NPM_PUBLISH_PRESENT" };
  }
  // Direct `npm publish` (without stage) must not appear as an executable command.
  if (/^\s*npm publish\b/m.test(publishJob)) {
    return { ok: false, reason: "DIRECT_NPM_PUBLISH_PRESENT" };
  }

  const publishSetup = extractSetupNodeWithBlock(publishJob);
  if (!publishSetup) {
    return { ok: false, reason: "MISSING_PUBLISH_SETUP_NODE" };
  }
  if (/^\s*registry-url\s*:/m.test(publishSetup)) {
    return { ok: false, reason: "PUBLISH_SETUP_NODE_HAS_REGISTRY_URL" };
  }

  const packSetup = extractSetupNodeWithBlock(packJob);
  if (!packSetup) {
    return { ok: false, reason: "MISSING_PACK_SETUP_NODE" };
  }
  if (/^\s*registry-url\s*:/m.test(packSetup)) {
    return { ok: false, reason: "PACK_SETUP_NODE_HAS_REGISTRY_URL" };
  }

  if (!/NODE_AUTH_TOKEN/.test(publishJob) || !/NPM_TOKEN/.test(publishJob)) {
    return { ok: false, reason: "MISSING_TOKEN_FAIL_CLOSED_GUARD" };
  }
  if (!/long-lived npm token env must not be present for trusted publishing/.test(publishJob)) {
    // Accept either the stage-step message or the earlier toolchain message.
    if (!/must not receive npm auth tokens/.test(publishJob)) {
      return { ok: false, reason: "MISSING_TOKEN_FAIL_CLOSED_GUARD" };
    }
  }
  // Must not "fix" the injection by unsetting before the guard.
  if (/^\s*unset\s+NODE_AUTH_TOKEN\b/m.test(publishJob) || /^\s*unset\s+NPM_TOKEN\b/m.test(publishJob)) {
    return { ok: false, reason: "UNCONDITIONAL_UNSET_BEFORE_GUARD" };
  }

  if (!/github\.event_name == 'workflow_dispatch' && inputs\.confirm_publish == true && github\.ref_type == 'tag'/.test(publishJob)) {
    return { ok: false, reason: "PUBLISH_NOT_TAG_DISPATCH_GATED" };
  }

  return { ok: true, publishJob, packJob };
}

/**
 * @param {string} jobYaml
 * @returns {string | null}
 */
function extractSetupNodeWithBlock(jobYaml) {
  const marker = /uses:\s*actions\/setup-node@v\d+\s*\n\s*with:\n/;
  const match = marker.exec(jobYaml);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  const after = jobYaml.slice(start + match[0].length);
  // Collect indented `with:` entries until a less-indented key.
  const lines = after.split("\n");
  const collected = [match[0].trimEnd()];
  for (const line of lines) {
    if (line.length === 0) {
      collected.push(line);
      continue;
    }
    if (/^ {10}/.test(line) || /^ {8}#/.test(line) || /^ {8}[a-zA-Z0-9_-]+:/.test(line)) {
      // still inside with: or its comments (8 spaces for keys under with at typical GHA indent)
      collected.push(line);
      // stop when we hit a new step-level key at 6 spaces: "      - name:"
      if (/^ {6}- /.test(line)) {
        break;
      }
      continue;
    }
    if (/^ {6}- /.test(line) || /^ {4}[a-zA-Z]/.test(line) || /^ {2}[a-zA-Z]/.test(line)) {
      break;
    }
    collected.push(line);
  }
  return collected.join("\n");
}
