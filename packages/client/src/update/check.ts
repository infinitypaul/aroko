import {
  compareSemver,
  isNewerSemver,
  isOlderSemver,
  isSameSemver,
  SemverError
} from "./semver.js";
import type { CompatibilityPreflight, TrustedRelease, UpdateCheckResult } from "./types.js";

export function checkCompatibility(input: {
  installedProtocolVersion: string;
  installedStateSchemaVersion: string;
  target: TrustedRelease;
}): CompatibilityPreflight {
  const { installedProtocolVersion, installedStateSchemaVersion, target } = input;
  try {
    if (compareSemver(target.protocolVersion, installedProtocolVersion) < 0) {
      return {
        ok: false,
        reason: `Target protocol ${target.protocolVersion} is older than installed ${installedProtocolVersion}; refusing install.`
      };
    }
    if (compareSemver(target.stateSchemaVersion, installedStateSchemaVersion) < 0) {
      return {
        ok: false,
        reason: `Target state schema ${target.stateSchemaVersion} is older than installed ${installedStateSchemaVersion}; refusing install (no speculative .pairmesh migration).`
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Unable to compare compatibility versions: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  return { ok: true };
}

export function evaluateUpdateCheck(input: {
  installedVersion: string;
  available: TrustedRelease;
}): UpdateCheckResult {
  const { installedVersion, available } = input;
  try {
    if (isSameSemver(available.version, installedVersion)) {
      return {
        status: "up-to-date",
        installedVersion,
        available,
        message: `Aroko ${installedVersion} is up to date.`
      };
    }
    if (isNewerSemver(available.version, installedVersion)) {
      return {
        status: "update-available",
        installedVersion,
        available,
        message: [
          `Aroko ${available.version} is available.`,
          "",
          `Installed: ${installedVersion}`,
          `Available: ${available.version}`,
          `Commit: ${available.gitCommit.slice(0, 12)}…`,
          `Protocol: ${available.protocolVersion}`,
          `State schema: ${available.stateSchemaVersion}`,
          "",
          "Run `aroko update` to review and install."
        ].join("\n")
      };
    }
    if (isOlderSemver(available.version, installedVersion)) {
      return {
        status: "newer-than-channel",
        installedVersion,
        available,
        message: "Installed version is newer than the selected release.",
        reason: `Installed ${installedVersion} > channel ${available.version}`
      };
    }
  } catch (error) {
    if (error instanceof SemverError) {
      return {
        status: "unable-to-verify",
        installedVersion,
        reason: error.message,
        message: `Unable to verify updates: ${error.message}`
      };
    }
    throw error;
  }
  return {
    status: "unable-to-verify",
    installedVersion,
    message: "Unable to verify updates: unexpected version comparison result."
  };
}
