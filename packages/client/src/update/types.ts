export type TrustedRelease = {
  version: string;
  releaseId: string;
  gitCommit: string;
  gitTag: string;
  publishedAt: string;
  artifactUrl: string;
  artifactSha256: string;
  artifactName: string;
  protocolVersion: string;
  stateSchemaVersion: string;
  notes?: string;
};

export type TrustedChannelDocument = {
  product: string;
  packageName: string;
  /** Selected / current channel tip (must appear in releases). */
  currentVersion: string;
  releases: TrustedRelease[];
};

export type UpdateCheckStatus =
  "up-to-date" | "update-available" | "unable-to-verify" | "newer-than-channel";

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  installedVersion: string;
  available?: TrustedRelease;
  message: string;
  reason?: string;
};

export type CompatibilityPreflight = { ok: true } | { ok: false; reason: string };

export type ArtifactVerifyResult =
  { ok: true; sha256: string; bytes: number; path: string } | { ok: false; reason: string };

export type InstallPlan = {
  target: TrustedRelease;
  verifiedArtifactPath: string;
  isDowngrade: boolean;
  packageName: string;
};

export type InstallOutcome = { ok: true; installedVersion: string } | { ok: false; reason: string };
