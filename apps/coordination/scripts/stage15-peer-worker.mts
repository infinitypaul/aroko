/**
 * Stage 15 Prompt 7 — peer worker (one OS process per participant).
 * Extends Stage 14 process model with controlled-action IPC.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LocalStateStore,
  PairMeshRelayClient,
  RelayChannelManager,
  SessionManager,
  digestWorkingTree,
  encodePublicKey,
  generateTransportKeyPair,
  isPairedWithLocal,
  type RelayAccessToken,
  type RelaySessionId,
  type TransportKeyPair
} from "../../../packages/client/src/index.ts";
import { createPairMeshA2AAgent } from "../src/a2a/index.js";

type Role = "paul" | "kelvin" | "sarah";
interface Cmd {
  type: string;
  [key: string]: unknown;
}

const role = (process.env.PAIRMESH_SMOKE_ROLE ?? "paul") as Role;

let agent: ReturnType<typeof createPairMeshA2AAgent> | null = null;
let manager: SessionManager | null = null;
let stateStore: LocalStateStore | null = null;
let agentBaseUrl = "";
let participantId = "";
let workspaceRoot = "";
let relayClient: PairMeshRelayClient | null = null;
let channelManager: RelayChannelManager | null = null;
let transportKeyPair: TransportKeyPair | null = null;
const receivedByChannel = new Map<string, string[]>();

function reply(payload: Record<string, unknown>, req?: unknown): void {
  process.send?.(req !== undefined ? { ...payload, _req: req } : payload);
}

function mgr(): SessionManager {
  if (!manager) throw new Error("not initialized");
  return manager;
}

function store(): LocalStateStore {
  if (!stateStore) throw new Error("not initialized");
  return stateStore;
}

function errFields(error: unknown): { code?: string; message: string } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  return { message, ...(code ? { code } : {}) };
}

async function waitReachable(url: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout ${url}`);
}

async function writeTestsConfig(workspace: string, profileName: string): Promise<void> {
  const pairmeshDir = join(workspace, ".pairmesh");
  await mkdir(pairmeshDir, { recursive: true });
  const configPath = join(pairmeshDir, "config.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const projectId =
    typeof existing.projectId === "string" && existing.projectId.startsWith("prj_")
      ? existing.projectId
      : `prj_${randomUUID()}`;
  const agent =
    existing.agent && typeof existing.agent === "object"
      ? (existing.agent as Record<string, unknown>)
      : { name: `${role}-agent`, port: "auto" as const };
  const next = {
    configVersion: "0.1.0",
    projectId,
    agent: {
      name: typeof agent.name === "string" ? agent.name : `${role}-agent`,
      port: agent.port === "auto" || typeof agent.port === "number" ? agent.port : "auto"
    },
    workspace,
    codingAgent: {
      provider: "fake",
      mode: "ask"
    },
    connectivity: { mode: "direct-url" },
    tests: {
      maxConcurrent: 1,
      sessionAllowedProfiles: [profileName],
      profiles: {
        [profileName]: {
          executable: "node",
          args: ["src/retry.test.mjs"],
          timeoutMs: 15_000,
          maxOutputBytes: 8_192
        }
      }
    }
  };
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function handle(msg: Cmd): Promise<void> {
  const req = msg._req;
  const respond = (payload: Record<string, unknown>) => reply(payload, req);

  switch (msg.type) {
    case "init": {
      const port = Number(msg.agentPort);
      const agentName = String(msg.agentName);
      const stateFile = String(msg.stateFile);
      workspaceRoot = String(msg.workspaceRoot ?? "");
      process.env.PAIRMESH_STATE_FILE = stateFile;
      process.env.PAIRMESH_WORKSPACE = workspaceRoot;
      process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
      if (workspaceRoot && msg.writeTestsConfig !== false) {
        await writeTestsConfig(workspaceRoot, String(msg.profileName ?? "payment-retry"));
      }
      agent = createPairMeshA2AAgent({
        name: agentName,
        host: "127.0.0.1",
        port,
        fakeAgentDelayMs: 0
      });
      agentBaseUrl = agent.baseUrl;
      await waitReachable(agent.agentCardUrl);
      stateStore = new LocalStateStore({ stateFilePath: stateFile });
      manager = new SessionManager({
        stateStore,
        ...(workspaceRoot ? { workspaceRoot } : {})
      });
      transportKeyPair = generateTransportKeyPair();
      respond({
        ok: true,
        type: "init",
        role,
        pid: process.pid,
        agentBaseUrl,
        workspaceRoot,
        transportPublicKey: encodePublicKey(transportKeyPair.publicKey)
      });
      return;
    }
    case "create_session": {
      const created = await mgr().createSession({
        name: String(msg.agentName),
        agentUrl: agentBaseUrl
      });
      participantId = created.localParticipant.participant.id;
      respond({
        ok: true,
        type: "create_session",
        sessionCode: created.sessionCode,
        inviteSecret: created.invite.inviteSecret,
        participantId,
        sessionId: created.sessionId
      });
      return;
    }
    case "create_invite": {
      const invite = await mgr().createSessionInvite(
        msg.initialGrants
          ? {
              initialGrants: msg.initialGrants as Array<{
                capabilityId: string;
                policy: "allow_session" | "deny" | "approval_required";
              }>
            }
          : undefined
      );
      respond({ ok: true, type: "create_invite", inviteSecret: invite.inviteSecret });
      return;
    }
    case "join_session": {
      const status = await mgr().joinSession({
        sessionCode: String(msg.sessionCode),
        peerUrl: String(msg.peerUrl),
        inviteSecret: String(msg.inviteSecret),
        name: String(msg.agentName),
        agentUrl: agentBaseUrl
      });
      participantId = status.localParticipant.participant.id;
      respond({
        ok: true,
        type: "join_session",
        participantId,
        peerCount: status.peers.length,
        sessionId: status.sessionId
      });
      return;
    }
    case "establish_relationship": {
      await mgr().establishRelationship({
        peerUrl: String(msg.peerUrl),
        inviteSecret: String(msg.inviteSecret)
      });
      respond({ ok: true, type: "establish_relationship" });
      return;
    }
    case "set_capability": {
      const result = await mgr().setPeerCapability(
        String(msg.peerRef),
        String(msg.capabilityId),
        String(msg.policy) as "allow_session" | "deny" | "approval_required"
      );
      respond({ ok: true, type: "set_capability", ...result });
      return;
    }
    case "status": {
      const status = await mgr().getSessionStatus();
      respond({
        ok: true,
        type: "status",
        participantId: status.localParticipant.participant.id,
        sessionCode: status.sessionCode,
        peers: status.peers.map((p) => ({
          name: p.agent.name,
          participantId: p.participant.id,
          paired: isPairedWithLocal(p)
        }))
      });
      return;
    }
    case "working_tree_digest": {
      if (!workspaceRoot) throw new Error("no workspace");
      const digest = await digestWorkingTree(workspaceRoot);
      respond({ ok: true, type: "working_tree_digest", ...digest });
      return;
    }
    case "read_file": {
      if (!workspaceRoot) throw new Error("no workspace");
      const rel = String(msg.path);
      const absolute = join(workspaceRoot, rel);
      const bytes = await readFile(absolute);
      respond({
        ok: true,
        type: "read_file",
        path: rel,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        text: bytes.toString("utf8")
      });
      return;
    }
    case "request_peer_action": {
      try {
        const wire = await mgr().requestPeerAction({
          peerRef: String(msg.peerRef),
          actionType: String(msg.actionType),
          ...(msg.parameters ? { parameters: msg.parameters as Record<string, unknown> } : {}),
          ...(msg.artifactRef
            ? {
                artifactRef: msg.artifactRef as {
                  artifactId: string;
                  contentHash: string;
                  artifactType: string;
                }
              }
            : {}),
          ...(msg.actionId ? { actionId: String(msg.actionId) as `act_${string}` } : {})
        });
        respond({ ok: true, type: "request_peer_action", wire });
      } catch (error) {
        respond({ ok: false, type: "request_peer_action", ...errFields(error) });
      }
      return;
    }
    case "wait_for_action": {
      try {
        const result = await mgr().waitForAction(String(msg.actionId), {
          waitMs: Number(msg.waitMs ?? 60_000),
          pollIntervalMs: Number(msg.pollIntervalMs ?? 250)
        });
        respond({ ok: true, type: "wait_for_action", ...result });
      } catch (error) {
        respond({ ok: false, type: "wait_for_action", ...errFields(error) });
      }
      return;
    }
    case "get_peer_action_status": {
      try {
        const action = await mgr().getPeerActionStatus(String(msg.actionId));
        respond({ ok: true, type: "get_peer_action_status", action });
      } catch (error) {
        respond({ ok: false, type: "get_peer_action_status", ...errFields(error) });
      }
      return;
    }
    case "get_local_action": {
      try {
        const action = await mgr().getAction(String(msg.actionId));
        respond({ ok: true, type: "get_local_action", action });
      } catch (error) {
        respond({ ok: false, type: "get_local_action", ...errFields(error) });
      }
      return;
    }
    case "list_pending_actions": {
      const actions = await mgr().listPendingActions();
      respond({ ok: true, type: "list_pending_actions", actions });
      return;
    }
    case "review_action": {
      try {
        const proposal = await mgr().reviewActionProposal(String(msg.actionId));
        respond({ ok: true, type: "review_action", proposal });
      } catch (error) {
        respond({ ok: false, type: "review_action", ...errFields(error) });
      }
      return;
    }
    case "approve_action": {
      try {
        const action = await mgr().approveAction(
          String(msg.actionId),
          String(msg.decision ?? "allow-once") as "allow-once" | "allow-session" | "deny"
        );
        respond({ ok: true, type: "approve_action", action });
      } catch (error) {
        respond({ ok: false, type: "approve_action", ...errFields(error) });
      }
      return;
    }
    case "deny_action": {
      try {
        const action = await mgr().denyAction(String(msg.actionId));
        respond({ ok: true, type: "deny_action", action });
      } catch (error) {
        respond({ ok: false, type: "deny_action", ...errFields(error) });
      }
      return;
    }
    case "cancel_peer_action": {
      try {
        const action = await mgr().cancelPeerAction(String(msg.actionId));
        respond({ ok: true, type: "cancel_peer_action", action });
      } catch (error) {
        respond({ ok: false, type: "cancel_peer_action", ...errFields(error) });
      }
      return;
    }
    case "force_expire_approval": {
      // Validation-harness only: expires pending approval without mutating workspace files.
      const state = await store().load();
      if (!state) throw new Error("no state");
      const actionId = String(msg.actionId);
      const past = "2020-01-01T00:00:00.000Z";
      const actionExecutions = (state.actionExecutions ?? []).map((entry) =>
        entry.actionId === actionId && entry.approvalBinding
          ? {
              ...entry,
              approvalBinding: { ...entry.approvalBinding, expiresAt: past }
            }
          : entry
      );
      const permissionRequests = (state.permissionRequests ?? []).map((entry) =>
        entry.correlationRequestId === actionId ? { ...entry, expiresAt: past } : entry
      );
      await store().save({ ...state, actionExecutions, permissionRequests });
      respond({ ok: true, type: "force_expire_approval", actionId });
      return;
    }
    case "mutate_tests_profile": {
      if (!workspaceRoot) throw new Error("no workspace");
      const profileName = String(msg.profileName ?? "payment-retry");
      const configPath = join(workspaceRoot, ".pairmesh", "config.json");
      const existing = JSON.parse(await readFile(configPath, "utf8")) as {
        tests?: {
          profiles?: Record<string, { timeoutMs?: number; [k: string]: unknown }>;
          [k: string]: unknown;
        };
        [k: string]: unknown;
      };
      const profile = existing.tests?.profiles?.[profileName];
      if (!profile) throw new Error(`missing profile ${profileName}`);
      const nextTimeout = Number(msg.timeoutMs ?? (profile.timeoutMs ?? 15_000) + 1);
      existing.tests = {
        ...existing.tests,
        profiles: {
          ...existing.tests?.profiles,
          [profileName]: { ...profile, timeoutMs: nextTimeout }
        }
      };
      await writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
      respond({ ok: true, type: "mutate_tests_profile", profileName, timeoutMs: nextTimeout });
      return;
    }
    case "relay_attach": {
      if (!transportKeyPair) throw new Error("no transport key");
      if (relayClient) await relayClient.close().catch(() => undefined);
      receivedByChannel.clear();
      transportKeyPair = generateTransportKeyPair();
      if (msg.participantId) participantId = String(msg.participantId);
      const relaySessionId = String(msg.relaySessionId) as RelaySessionId;
      relayClient = new PairMeshRelayClient({
        relayUrl: String(msg.relayUrl),
        relaySessionId,
        relayAccessToken: String(msg.relayAccessToken) as RelayAccessToken,
        fromParticipantId: participantId
      });
      channelManager = new RelayChannelManager(relayClient, {
        relaySessionId,
        sessionId: String(msg.sessionId ?? "smoke-collab")
      });
      relayClient.onPlaintext((plaintext, meta) => {
        const key = meta.channelId ?? "none";
        const list = receivedByChannel.get(key) ?? [];
        list.push(new TextDecoder().decode(plaintext));
        receivedByChannel.set(key, list);
      });
      await relayClient.connect();
      respond({
        ok: true,
        type: "relay_attach",
        connectionId: relayClient.id,
        attached: relayClient.isAttached,
        transportPublicKey: encodePublicKey(transportKeyPair.publicKey),
        participantId
      });
      return;
    }
    case "relay_open_channel": {
      if (!channelManager || !transportKeyPair) throw new Error("relay not ready");
      const record = channelManager.openChannel({
        remoteParticipantId: String(msg.remoteParticipantId),
        remotePublicKey: String(msg.remotePublicKey),
        localParticipantId: participantId,
        localPrivateKey: transportKeyPair.privateKey
      });
      respond({
        ok: true,
        type: "relay_open_channel",
        channelId: record.channelId,
        remoteParticipantId: String(msg.remoteParticipantId)
      });
      return;
    }
    case "relay_send": {
      if (!relayClient) throw new Error("relay not attached");
      await relayClient.sendPlaintext(new TextEncoder().encode(String(msg.text)), {
        toParticipantId: String(msg.toParticipantId),
        channelId: String(msg.channelId),
        fromParticipantId: participantId
      });
      respond({ ok: true, type: "relay_send" });
      return;
    }
    case "relay_received": {
      const messages = [...(receivedByChannel.get(String(msg.channelId)) ?? [])];
      receivedByChannel.set(String(msg.channelId), []);
      respond({ ok: true, type: "relay_received", messages });
      return;
    }
    case "relay_detach": {
      if (relayClient) {
        await relayClient.close();
        relayClient = null;
        channelManager = null;
      }
      respond({ ok: true, type: "relay_detach" });
      return;
    }
    case "shutdown": {
      if (relayClient) await relayClient.close().catch(() => undefined);
      if (agent) await agent.close();
      respond({ ok: true, type: "shutdown" });
      setTimeout(() => process.exit(0), 30);
      return;
    }
    default:
      respond({ ok: false, error: `unknown:${msg.type}` });
  }
}

process.on("message", (raw) => {
  const msg = raw as Cmd;
  void handle(msg).catch((error) => {
    reply(
      {
        ok: false,
        type: msg.type,
        ...errFields(error),
        error: errFields(error).message
      },
      msg._req
    );
  });
});

reply({ ok: true, type: "ready", role, pid: process.pid });
