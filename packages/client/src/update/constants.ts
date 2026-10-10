/** Canonical public/staging package identity — never taken from untrusted metadata. */
export const CANONICAL_CLI_PACKAGE_NAME = "@arokodev/cli";

/** Env keys for the trusted release channel URL (fixture or future official endpoint). */
export const RELEASE_CHANNEL_URL_ENV = [
  "AROKO_RELEASE_CHANNEL_URL",
  "PAIRMESH_RELEASE_CHANNEL_URL"
] as const;

/** Hard cap on artifact download size (bytes). Staged CLI is ~6–20 MiB. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

/** Capability / skill / tool name fragments that must never appear as peer-facing update surfaces. */
export const FORBIDDEN_PEER_UPDATE_FRAGMENTS = [
  "software.update",
  "aroko.update",
  "pairmesh.update",
  "system.install",
  "system.update",
  "package.install",
  "cli.update"
] as const;
