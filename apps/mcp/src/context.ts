import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  applyResolvedLocalRuntimeToEnv,
  LocalStateStore,
  resolveLocalRuntime,
  SessionManager
} from "@pairmesh/client";
import { createPairMeshMcpServer } from "./create-server.js";

export async function createSessionManagerFromResolvedConfig(): Promise<{
  manager: SessionManager;
  workspace?: string;
}> {
  if (process.env.PAIRMESH_STATE_FILE?.trim()) {
    const stateStore = new LocalStateStore({ stateFilePath: process.env.PAIRMESH_STATE_FILE });
    const workspace = process.env.PAIRMESH_PROJECT_ROOT?.trim();
    return {
      manager: new SessionManager({
        stateStore,
        ...(workspace ? { workspaceRoot: workspace } : {})
      }),
      ...(workspace ? { workspace } : {})
    };
  }

  try {
    const runtime = await resolveLocalRuntime();
    applyResolvedLocalRuntimeToEnv(runtime);
    const stateStore = new LocalStateStore({ stateFilePath: runtime.stateFilePath });
    return {
      manager: new SessionManager({
        stateStore,
        workspaceRoot: runtime.workspace
      }),
      workspace: runtime.workspace
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PairMesh MCP could not resolve project config.\n${message}\n\nEnsure PAIRMESH_PROJECT_ROOT is set in your MCP client config (for example Claude Desktop claude_desktop_config.json or Cursor .cursor/mcp.json), or run from an initialized project directory.`
    );
  }
}

/** @deprecated use createSessionManagerFromResolvedConfig */
export function createSessionManagerFromEnv(): SessionManager {
  const stateFilePath = process.env.PAIRMESH_STATE_FILE;
  const stateStore = stateFilePath ? new LocalStateStore({ stateFilePath }) : new LocalStateStore();
  return new SessionManager({ stateStore });
}

export async function runPairMeshMcpStdio(): Promise<void> {
  const { manager, workspace } = await createSessionManagerFromResolvedConfig();
  await serveStdio(() =>
    createPairMeshMcpServer(manager, {
      workspace
    })
  );
}
