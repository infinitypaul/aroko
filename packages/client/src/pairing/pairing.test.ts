import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { PAIRMESH_SESSION_SKILL_ID } from "@pairmesh/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalConfig, loadConfigFile } from "../local-config/resolver.js";
import { configFilePath } from "../local-config/paths.js";
import { writeRuntimeInfo } from "../local-config/runtime-info.js";
import { buildAdvertisedUrl, describeAdvertisedAddress, isLocalhostPeerUrl } from "./address.js";
import {
  computeRuntimeMetadata,
  requireActiveRuntime,
  RuntimeNotRunningError
} from "./active-runtime.js";
import { createJoinCommand } from "./join-command.js";
import { preflightJoinPeer } from "./join-preflight.js";

function startMockPeer(options: {
  includeSessionSkill: boolean;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const skills = options.includeSessionSkill
    ? [{ id: PAIRMESH_SESSION_SKILL_ID, name: "PairMesh Session", description: "pair", tags: [] }]
    : [{ id: "echo", name: "echo", description: "echo", tags: [] }];

  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          agent: { name: "mock-agent" },
          codingAgent: { provider: "fake", configured: true, status: "available" },
          timestamp: new Date().toISOString(),
          readyForInspection: true
        })
      );
      return;
    }
    if (req.url === `/${AGENT_CARD_PATH}`) {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "mock-agent",
          description: "test",
          url: baseUrl,
          version: "0.0.1",
          capabilities: {},
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          skills
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          })
      });
    });
    server.on("error", reject);
  });
}

describe("pairing address", () => {
  it("builds advertised URL from host and port", () => {
    expect(
      buildAdvertisedUrl({ bindHost: "127.0.0.1", port: 47_105, advertise: "192.168.1.20" })
    ).toBe("http://192.168.1.20:47105");
  });

  it("defaults to localhost base URL", () => {
    const meta = computeRuntimeMetadata({ bindHost: "127.0.0.1", port: 47_102 });
    expect(meta.baseUrl).toBe("http://127.0.0.1:47102");
    expect(meta.advertisedUrl).toBe("http://127.0.0.1:47102");
    expect(isLocalhostPeerUrl(meta.advertisedUrl)).toBe(true);
    expect(describeAdvertisedAddress(meta.advertisedUrl)).toBe("localhost only");
  });

  it("uses bind 0.0.0.0 locally via 127.0.0.1 for baseUrl", () => {
    const meta = computeRuntimeMetadata({
      bindHost: "0.0.0.0",
      port: 47_103,
      advertise: "192.168.1.20"
    });
    expect(meta.baseUrl).toBe("http://127.0.0.1:47103");
    expect(meta.advertisedUrl).toBe("http://192.168.1.20:47103");
  });

  it("generates join command with selected port", () => {
    const meta = computeRuntimeMetadata({
      bindHost: "127.0.0.1",
      port: 47_105,
      advertise: "192.168.1.20"
    });
    const invite = createJoinCommand({
      sessionCode: "PM-TEST01",
      peerUrl: meta.advertisedUrl
    });
    expect(invite.joinCommand).toBe("aroko join PM-TEST01 --peer http://192.168.1.20:47105");
  });

  it("includes the single-use invite secret when one is supplied", () => {
    const invite = createJoinCommand({
      sessionCode: "PM-TEST01",
      peerUrl: "http://192.168.1.20:47105",
      inviteSecret: "s3cret-invite-value"
    });
    expect(invite.joinCommand).toBe(
      "aroko join PM-TEST01 --peer http://192.168.1.20:47105 --invite s3cret-invite-value"
    );
  });
});

describe("active runtime", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-pairing-"));
    tempDirs.push(dir);
    return dir;
  }

  it("requires running runtime for create", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent" });
    await expect(requireActiveRuntime(workspace)).rejects.toBeInstanceOf(RuntimeNotRunningError);
  });

  it("reads peer URL from runtime metadata", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent" });
    await writeRuntimeInfo(workspace, {
      pid: process.pid,
      port: 47_105,
      baseUrl: "http://127.0.0.1:47105",
      bindHost: "127.0.0.1",
      advertisedUrl: "http://192.168.1.20:47105",
      agentName: "paul-agent",
      startedAt: new Date().toISOString()
    });

    const active = await requireActiveRuntime(workspace);
    expect(active.peerUrl).toBe("http://192.168.1.20:47105");
  });

  it("loads Stage 4 Prompt 1 config without new fields", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent" });
    const config = await loadConfigFile(configFilePath(workspace));
    expect(config.agent.bindHost).toBeUndefined();
    expect(config.agent.advertise).toBeUndefined();
  });
});

describe("join preflight", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("accepts reachable peer with pairmesh.session skill", async () => {
    const peer = await startMockPeer({ includeSessionSkill: true });
    closers.push(peer.close);
    await preflightJoinPeer(peer.baseUrl);
  });

  it("rejects unreachable peer", async () => {
    await expect(preflightJoinPeer("http://127.0.0.1:47199")).rejects.toThrow(
      /Cannot reach PairMesh peer/
    );
  });

  it("rejects invalid URL", async () => {
    await expect(preflightJoinPeer("not-a-url")).rejects.toThrow(/invalid/i);
  });

  it("rejects agent without pairmesh session skill", async () => {
    const peer = await startMockPeer({ includeSessionSkill: false });
    closers.push(peer.close);
    await expect(preflightJoinPeer(peer.baseUrl)).rejects.toThrow(
      /does not support PairMesh session pairing/
    );
  });
});
