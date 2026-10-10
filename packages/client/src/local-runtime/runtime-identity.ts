
import {
  PAIRMESH_BUILD_ID,
  PAIRMESH_BUILD_TIMESTAMP,
  PAIRMESH_VERSION,
  type PairMeshBuildInfo
} from "../build-info.js";

/** Bump only on breaking Control HTTP/schema changes. */
export const CONTROL_API_SCHEMA_VERSION = 1;

export interface RuntimeIdentity {
  version: string;
  buildId: string;
  buildTimestamp: string;
  controlApiSchemaVersion: number;
}

export function readInstalledRuntimeIdentity(
  build: PairMeshBuildInfo = {
    version: PAIRMESH_VERSION,
    buildId: PAIRMESH_BUILD_ID,
    buildTimestamp: PAIRMESH_BUILD_TIMESTAMP
  }
): RuntimeIdentity {
  return {
    version: build.version,
    buildId: build.buildId,
    buildTimestamp: build.buildTimestamp,
    controlApiSchemaVersion: CONTROL_API_SCHEMA_VERSION
  };
}

export function runtimeIdentityFromControlStatus(status: {
  version: string;
  buildId?: string;
  buildTimestamp?: string;
  controlApiSchemaVersion?: number;
}): RuntimeIdentity {
  return {
    version: status.version,
    buildId: status.buildId?.trim() || "unknown",
    buildTimestamp: status.buildTimestamp?.trim() || "",
    controlApiSchemaVersion:
      typeof status.controlApiSchemaVersion === "number"
        ? status.controlApiSchemaVersion
        : CONTROL_API_SCHEMA_VERSION
  };
}
