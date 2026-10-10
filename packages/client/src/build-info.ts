export {
  AROKO_VERSION,
  AROKO_BUILD_ID,
  AROKO_BUILD_TIMESTAMP,
  AROKO_GIT_COMMIT,
  AROKO_GIT_TAG,
  AROKO_RELEASE_ID,
  AROKO_PROTOCOL_VERSION,
  AROKO_STATE_SCHEMA_VERSION,
  AROKO_IS_DIRTY,
  AROKO_BUILD_MODE,
  PAIRMESH_VERSION,
  PAIRMESH_BUILD_ID,
  PAIRMESH_BUILD_TIMESTAMP,
  PAIRMESH_GIT_COMMIT,
  PAIRMESH_GIT_TAG,
  PAIRMESH_RELEASE_ID,
  PAIRMESH_PROTOCOL_VERSION,
  PAIRMESH_STATE_SCHEMA_VERSION,
  PAIRMESH_IS_DIRTY,
  PAIRMESH_BUILD_MODE
} from "./build-info.generated.js";

export interface ArokoBuildInfo {
  version: string;
  buildId: string;
  buildTimestamp: string;
  productVersion?: string;
  packageVersion?: string;
  releaseId?: string;
  gitCommit?: string;
  gitTag?: string;
  protocolVersion?: string;
  stateSchemaVersion?: string;
  isDirty?: boolean;
  buildMode?: "development" | "release";
  nodeVersion?: string;
  artifactSha256?: string;
  product?: string;
}

/** @deprecated Prefer ArokoBuildInfo */
export type PairMeshBuildInfo = ArokoBuildInfo;
