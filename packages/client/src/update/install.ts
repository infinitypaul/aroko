import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CANONICAL_CLI_PACKAGE_NAME } from "./constants.js";
import { isOlderSemver } from "./semver.js";
import { checkCompatibility } from "./check.js";
import type { InstallOutcome, InstallPlan, TrustedRelease } from "./types.js";

const execFileAsync = promisify(execFile);

export type PackageInstallExecutor = (input: {
  packageName: string;
  verifiedArtifactPath: string;
  prefix?: string;
}) => Promise<void>;

export type VersionProbe = (prefix?: string) => Promise<string>;

/** Deterministic npm global install from a verified local tarball path — no shell, no manifest scripts. */
export async function defaultNpmInstallExecutor(input: {
  packageName: string;
  verifiedArtifactPath: string;
  prefix?: string;
}): Promise<void> {
  if (input.packageName !== CANONICAL_CLI_PACKAGE_NAME) {
    throw new Error(`Refusing to install unexpected package: ${input.packageName}`);
  }
  const args = ["install", "-g", input.verifiedArtifactPath];
  if (input.prefix) {
    args.push("--prefix", input.prefix);
  }
  // Local verified tarball replace — required so explicit rollbacks are not blocked by npm's
  // default "do not downgrade" global behavior after owner consent.
  args.push("--force");
  await execFileAsync("npm", args, {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
}

export function planInstall(input: {
  installedVersion: string;
  installedProtocolVersion: string;
  installedStateSchemaVersion: string;
  target: TrustedRelease;
  verifiedArtifactPath: string;
  allowDowngrade: boolean;
}): { ok: true; plan: InstallPlan } | { ok: false; reason: string } {
  const compatibility = checkCompatibility({
    installedProtocolVersion: input.installedProtocolVersion,
    installedStateSchemaVersion: input.installedStateSchemaVersion,
    target: input.target
  });
  if (!compatibility.ok) {
    return compatibility;
  }

  let isDowngrade = false;
  try {
    isDowngrade = isOlderSemver(input.target.version, input.installedVersion);
  } catch (error) {
    return {
      ok: false,
      reason: `Unable to compare versions: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (isDowngrade && !input.allowDowngrade) {
    return {
      ok: false,
      reason:
        "Installed version is newer than the selected release. Pass an explicit version with --force-downgrade after review to roll back."
    };
  }

  return {
    ok: true,
    plan: {
      target: input.target,
      verifiedArtifactPath: input.verifiedArtifactPath,
      isDowngrade,
      packageName: CANONICAL_CLI_PACKAGE_NAME
    }
  };
}

export async function executeInstallPlan(input: {
  plan: InstallPlan;
  prefix?: string;
  installExecutor?: PackageInstallExecutor;
  versionProbe?: VersionProbe;
}): Promise<InstallOutcome> {
  const install = input.installExecutor ?? defaultNpmInstallExecutor;
  try {
    await install({
      packageName: input.plan.packageName,
      verifiedArtifactPath: input.plan.verifiedArtifactPath,
      prefix: input.prefix
    });
  } catch (error) {
    return {
      ok: false,
      reason: `Package installation failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (input.versionProbe) {
    try {
      const installedVersion = await input.versionProbe(input.prefix);
      if (installedVersion !== input.plan.target.version) {
        return {
          ok: false,
          reason: `Installed version ${installedVersion} does not match requested ${input.plan.target.version}.`
        };
      }
      return { ok: true, installedVersion };
    } catch (error) {
      return {
        ok: false,
        reason: `Post-install version verification failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  return { ok: true, installedVersion: input.plan.target.version };
}

export function formatInstallReview(input: {
  installedVersion: string;
  target: TrustedRelease;
  isDowngrade: boolean;
}): string {
  const lines = [
    input.isDowngrade
      ? "WARNING: This installs an older version (rollback/downgrade)."
      : "Review update:",
    "",
    `Installed: ${input.installedVersion}`,
    `Target:    ${input.target.version}`,
    `Release:   ${input.target.releaseId}`,
    `Commit:    ${input.target.gitCommit}`,
    `Checksum:  ${input.target.artifactSha256}`,
    `Protocol:  ${input.target.protocolVersion}`,
    `State:     ${input.target.stateSchemaVersion}`
  ];
  if (input.target.notes) {
    lines.push("", "Notes:", input.target.notes);
  }
  lines.push("", `Install Aroko ${input.target.version}? [y/N]`);
  return lines.join("\n");
}
