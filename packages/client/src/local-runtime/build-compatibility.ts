
import type { RuntimeIdentity } from "./runtime-identity.js";

export type RuntimeCompatibilityKind =
  "exact" | "compatible_different" | "restart_required" | "incompatible";

export interface RuntimeCompatibilityResult {
  kind: RuntimeCompatibilityKind;
  reason?: string;
}

/**
 * Compare installed CLI/package identity to the running runtime (from Control status).
 *
 * - exact: same buildId
 * - incompatible: Control schema major mismatch
 * - compatible_different: running runtime is newer than this CLI (do not downgrade)
 * - restart_required: installed build should replace the running process
 */
export function compareInstalledToRunning(
  installed: RuntimeIdentity,
  running: RuntimeIdentity
): RuntimeCompatibilityResult {
  if (installed.controlApiSchemaVersion !== running.controlApiSchemaVersion) {
    return {
      kind: "incompatible",
      reason: `Control API schema ${running.controlApiSchemaVersion} (runtime) is incompatible with ${installed.controlApiSchemaVersion} (CLI).`
    };
  }

  if (installed.buildId === running.buildId) {
    return { kind: "exact" };
  }

  if (
    installed.buildTimestamp &&
    running.buildTimestamp &&
    installed.buildTimestamp < running.buildTimestamp
  ) {
    return {
      kind: "compatible_different",
      reason: "Running runtime is newer than this CLI; not replacing with an older install."
    };
  }

  return {
    kind: "restart_required",
    reason: "Installed PairMesh build differs from the running runtime."
  };
}
