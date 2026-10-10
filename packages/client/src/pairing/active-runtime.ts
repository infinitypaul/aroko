import { loadConfigFile } from "../local-config/resolver.js";
import { isRuntimeProcessAlive, readRuntimeInfo } from "../local-config/runtime-info.js";
import {
  buildAdvertisedUrl,
  buildBaseUrl,
  isLocalhostPeerUrl,
  normalizeBindHost
} from "./address.js";
import type { PairMeshRuntimeInfo } from "../local-config/schema.js";

export class RuntimeNotRunningError extends Error {
  constructor() {
    super("PairMesh runtime is not running.\n\nStart it first:\n\n  pairmesh start");
    this.name = "RuntimeNotRunningError";
  }
}

export interface ActiveRuntimeContext {
  workspace: string;
  runtimeInfo: PairMeshRuntimeInfo;
  bindHost: string;
  baseUrl: string;
  peerUrl: string;
  localhostOnly: boolean;
}

export async function requireActiveRuntime(workspace: string): Promise<ActiveRuntimeContext> {
  const runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo || !(await isRuntimeProcessAlive(runtimeInfo))) {
    throw new RuntimeNotRunningError();
  }

  const bindHost = runtimeInfo.bindHost ?? "127.0.0.1";
  const baseUrl = runtimeInfo.baseUrl;
  const peerUrl = runtimeInfo.advertisedUrl ?? baseUrl;

  return {
    workspace,
    runtimeInfo,
    bindHost,
    baseUrl,
    peerUrl,
    localhostOnly: isLocalhostPeerUrl(peerUrl)
  };
}

export async function resolvePeerUrlForInvite(
  workspace: string,
  configFilePath: string
): Promise<string> {
  const active = await requireActiveRuntime(workspace);
  if (active.runtimeInfo.advertisedUrl) {
    return active.runtimeInfo.advertisedUrl;
  }

  const config = await loadConfigFile(configFilePath);
  return buildAdvertisedUrl({
    bindHost: active.bindHost,
    port: active.runtimeInfo.port,
    advertise: config.agent.advertise
  });
}

export function computeRuntimeMetadata(input: {
  bindHost: string;
  port: number;
  advertise?: string;
}): { baseUrl: string; advertisedUrl: string; bindHost: string } {
  const bindHost = normalizeBindHost(input.bindHost);
  const baseUrl = buildBaseUrl(bindHost, input.port);
  const advertisedUrl = buildAdvertisedUrl({
    bindHost,
    port: input.port,
    advertise: input.advertise
  });
  return { baseUrl, advertisedUrl, bindHost };
}
