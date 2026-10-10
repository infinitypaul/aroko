import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LocalStateStore, STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "./store.js";
import { SessionManager } from "../session/manager.js";
import { LocalSessionStateSchema } from "../session/schemas.js";

describe("LocalStateStore", () => {
  it("persists and reloads validated session state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-state-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const manager = new SessionManager({ stateStore: store });

    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const reloaded = new SessionManager({ stateStore: store });
    const status = await reloaded.getSessionStatus();
    expect(status.sessionCode).toBe(created.sessionCode);
    expect(status.localParticipant.agent.name).toBe("paul-agent");
  });

  it("rejects malformed state files safely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-state-"));
    const path = join(dir, "state.json");
    const store = new LocalStateStore({ stateFilePath: path });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, "{ not-valid-json", "utf8")
    );

    await expect(store.load()).rejects.toMatchObject({
      code: "pairmesh.invalid_metadata"
    });
  });

  it("does not store credentials, passwords, or source code fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-state-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    const raw = await readFile(join(dir, "state.json"), "utf8");
    expect(raw).not.toMatch(/password|apiKey|api_key|credentials/i);
    // Invite secrets are persisted as SHA-256 hashes only.
    expect(raw).not.toContain(created.invite.inviteSecret);
    expect(LocalSessionStateSchema.parse(JSON.parse(raw))).toBeDefined();
  });

  it("writes state with owner-only file and directory modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-state-"));
    const stateDir = join(dir, "nested");
    const stateFilePath = join(stateDir, "state.json");
    const store = new LocalStateStore({ stateFilePath });
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:4101"
    });

    if (process.platform === "win32") {
      return;
    }

    const fileStat = await stat(stateFilePath);
    const dirStat = await stat(stateDir);
    expect(fileStat.mode & 0o777).toBe(STATE_FILE_MODE);
    expect(dirStat.mode & 0o777).toBe(STATE_DIRECTORY_MODE);
  });
});
