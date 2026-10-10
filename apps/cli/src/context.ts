import {
  applyResolvedLocalRuntimeToEnv,
  LocalStateStore,
  resolveLocalRuntime,
  SessionManager
} from "@pairmesh/client";

export async function createSessionManagerFromResolvedConfig(
  cwd: string = process.cwd()
): Promise<SessionManager> {
  const runtime = await resolveLocalRuntime({ cwd });
  applyResolvedLocalRuntimeToEnv(runtime);
  const stateStore = new LocalStateStore({ stateFilePath: runtime.stateFilePath });
  return new SessionManager({ stateStore, workspaceRoot: runtime.workspace });
}

export async function getResolvedRuntime() {
  return await resolveLocalRuntime();
}
