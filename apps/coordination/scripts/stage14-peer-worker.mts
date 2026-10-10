/**
 * Stage 14 Prompt 3 — peer worker (one OS process per participant).
 */
import {
  LocalStateStore,
  PairMeshRelayClient,
  RelayChannelManager,
  SessionManager,
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
let agentBaseUrl = "";
let participantId = "";
let relayClient: PairMeshRelayClient | null = null;
let channelManager: RelayChannelManager | null = null;
let transportKeyPair: TransportKeyPair | null = null;
const receivedByChannel = new Map<string, string[]>();

function reply(payload: Record<string, unknown>): void {
  process.send?.(payload);
}

function mgr(): SessionManager {
  if (!manager) throw new Error("not initialized");
  return manager;
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

async function handle(msg: Cmd): Promise<void> {
  switch (msg.type) {
    case "init": {
      const port = Number(msg.agentPort);
      const agentName = String(msg.agentName);
      const stateFile = String(msg.stateFile);
      // Agent runtime and SessionManager must share the same local state file.
      process.env.PAIRMESH_STATE_FILE = stateFile;
      agent = createPairMeshA2AAgent({
        name: agentName,
        host: "127.0.0.1",
        port,
        // Deterministic inspection answers for Stage 14 chaos / repair gates.
        fakeAgentDelayMs: 0
      });
      agentBaseUrl = agent.baseUrl;
      await waitReachable(agent.agentCardUrl);
      manager = new SessionManager({
        stateStore: new LocalStateStore({ stateFilePath: stateFile })
      });
      transportKeyPair = generateTransportKeyPair();
      reply({
        ok: true,
        type: "init",
        role,
        pid: process.pid,
        agentBaseUrl,
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
      reply({
        ok: true,
        type: "create_session",
        sessionCode: created.sessionCode,
        inviteSecret: created.invite.inviteSecret,
        participantId
      });
      return;
    }
    case "create_invite": {
      const invite = await mgr().createSessionInvite(
        msg.initialGrants
          ? {
              initialGrants: msg.initialGrants as Array<{
                capabilityId: string;
                policy: "allow_session" | "deny" | "require_approval";
              }>
            }
          : undefined
      );
      reply({ ok: true, type: "create_invite", inviteSecret: invite.inviteSecret });
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
      reply({
        ok: true,
        type: "join_session",
        participantId,
        peerCount: status.peers.length
      });
      return;
    }
    case "establish_relationship": {
      await mgr().establishRelationship({
        peerUrl: String(msg.peerUrl),
        inviteSecret: String(msg.inviteSecret)
      });
      reply({ ok: true, type: "establish_relationship" });
      return;
    }
    case "status": {
      const status = await mgr().getSessionStatus();
      reply({
        ok: true,
        type: "status",
        participantId: status.localParticipant.participant.id,
        peers: status.peers.map((p) => ({
          name: p.agent.name,
          participantId: p.participant.id,
          paired: isPairedWithLocal(p)
        }))
      });
      return;
    }
    case "ask": {
      try {
        await mgr().askPeer(String(msg.peerRef), String(msg.question));
        reply({ ok: true, type: "ask" });
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: string }).code)
            : "unknown";
        reply({
          ok: false,
          type: "ask",
          code,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    case "remove_peer": {
      await mgr().removePeer(String(msg.peerRef));
      reply({ ok: true, type: "remove_peer" });
      return;
    }
    case "leave": {
      await mgr().leaveSession();
      if (relayClient) {
        await relayClient.close().catch(() => undefined);
        relayClient = null;
        channelManager = null;
      }
      reply({ ok: true, type: "leave" });
      return;
    }
    case "relay_attach": {
      if (!transportKeyPair) throw new Error("no transport key");
      if (relayClient) await relayClient.close().catch(() => undefined);
      receivedByChannel.clear();
      // Fresh transport keys after each attach (reconnect/rekey model)
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
      reply({
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
      reply({
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
      reply({ ok: true, type: "relay_send" });
      return;
    }
    case "relay_received": {
      const messages = [...(receivedByChannel.get(String(msg.channelId)) ?? [])];
      // Consume so callers can poll for new arrivals
      receivedByChannel.set(String(msg.channelId), []);
      reply({ ok: true, type: "relay_received", messages });
      return;
    }
    case "relay_close_channel": {
      channelManager?.closeChannel(String(msg.channelId));
      reply({ ok: true, type: "relay_close_channel" });
      return;
    }
    case "relay_detach": {
      if (relayClient) {
        await relayClient.close();
        relayClient = null;
        channelManager = null;
      }
      reply({ ok: true, type: "relay_detach" });
      return;
    }
    case "shutdown": {
      if (relayClient) await relayClient.close().catch(() => undefined);
      if (agent) await agent.close();
      reply({ ok: true, type: "shutdown" });
      setTimeout(() => process.exit(0), 30);
      return;
    }
    default:
      reply({ ok: false, error: `unknown:${msg.type}` });
  }
}

process.on("message", (raw) => {
  void handle(raw as Cmd).catch((error) => {
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
    reply({
      ok: false,
      type: (raw as Cmd).type,
      error: message,
      ...(code ? { code } : {})
    });
  });
});

reply({ ok: true, type: "ready", role, pid: process.pid });
