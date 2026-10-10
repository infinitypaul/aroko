import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalStateStore,
  SessionManager,
  STATE_DIRECTORY_MODE,
  STATE_FILE_MODE
} from "../index.js";
import {
  AuditLog,
  AUDIT_ROTATE_MAX_BYTES,
  buildAuditEvent,
  buildResultSharedMetadata,
  formatAuditEventHuman
} from "./index.js";

const INVITE_CANARY = "PAIR_MESH_TEST_INVITE_DO_NOT_LOG";
const BEARER_CANARY = "PAIR_MESH_TEST_BEARER_DO_NOT_LOG";
const SOURCE_CANARY = "PAIR_MESH_SECRET_SOURCE_CONTENT_DO_NOT_LOG";
const QUESTION_CANARY = "PAIR_MESH_PRIVATE_QUESTION_DO_NOT_LOG";
const ACP_CANARY = "PAIR_MESH_PRIVATE_ACP_TRANSCRIPT_DO_NOT_LOG";

describe("AuditLog", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    // Leave temp dirs for OS cleanup; tests only need isolation.
    tempDirs.length = 0;
  });

  async function tempAudit(): Promise<{ dir: string; log: AuditLog; eventsFile: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-audit-"));
    tempDirs.push(dir);
    const eventsFile = join(dir, "events.jsonl");
    return { dir, eventsFile, log: new AuditLog({ eventsFilePath: eventsFile }) };
  }

  it("appends validated events with owner-only modes", async () => {
    const { log, eventsFile, dir } = await tempAudit();
    log.record(
      buildAuditEvent({
        eventType: "session.created",
        metadata: {}
      })
    );
    await log.flush();

    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(dir)).mode & 0o777).toBe(STATE_DIRECTORY_MODE);
      expect((await stat(eventsFile)).mode & 0o777).toBe(STATE_FILE_MODE);
    }

    const events = await log.readRecent(10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("session.created");
  });

  it("survives a truncated previous JSONL line", async () => {
    const { log, eventsFile } = await tempAudit();
    await mkdir(join(eventsFile, ".."), { recursive: true });
    await writeFile(eventsFile, '{"version":"1","eventType":"session.created"\n', "utf8");
    log.record(buildAuditEvent({ eventType: "session.left", metadata: {} }));
    await log.flush();

    const events = await log.readRecent(10);
    expect(events.some((event) => event.eventType === "session.left")).toBe(true);
  });

  it("rotates when the active file exceeds the size limit", async () => {
    const { eventsFile } = await tempAudit();
    const oversized = new AuditLog({
      eventsFilePath: eventsFile,
      maxBytes: 200,
      keepRotated: 2
    });
    for (let index = 0; index < 20; index += 1) {
      oversized.record(
        buildAuditEvent({
          eventType: "session.created",
          metadata: {}
        })
      );
      await oversized.flush();
    }
    const rotated = await readFile(`${eventsFile}.1`, "utf8").catch(() => "");
    expect(rotated.length).toBeGreaterThan(0);
    expect(AUDIT_ROTATE_MAX_BYTES).toBeGreaterThan(0);
  });

  it("never persists canary secrets in audit bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-audit-canary-"));
    const stateFile = join(dir, "state.json");
    const store = new LocalStateStore({ stateFilePath: stateFile });
    const manager = new SessionManager({ stateStore: store, skipPeerHealthPreflight: true });

    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:47001"
    });

    // Attempt to poison audit with values that must never be written via builders.
    const audit = AuditLog.fromStateFile(stateFile);
    audit.record(
      buildAuditEvent({
        eventType: "inspection.result_shared",
        sessionId: created.sessionId,
        sessionCode: created.sessionCode,
        metadata: buildResultSharedMetadata({
          direction: "outbound",
          summary: SOURCE_CANARY,
          findings: [QUESTION_CANARY, ACP_CANARY],
          references: [{ file: "src/retry.ts", symbol: "rebuildPaymentFromRetryRecord" }]
        })
      })
    );
    await audit.flush();
    await manager.leaveSession();
    await manager.listAuditEvents(5);

    const eventsFile = join(dir, "audit", "events.jsonl");
    const raw = await readFile(eventsFile, "utf8");
    expect(raw).not.toContain(created.invite.inviteSecret);
    expect(raw).not.toContain(INVITE_CANARY);
    expect(raw).not.toContain(BEARER_CANARY);
    expect(raw).not.toContain(SOURCE_CANARY);
    expect(raw).not.toContain(QUESTION_CANARY);
    expect(raw).not.toContain(ACP_CANARY);
    expect(raw).not.toContain("Authorization: Bearer");
    expect(raw).not.toMatch(/\/Users\/|\/home\//);
    expect(raw).toContain("src/retry.ts");
    expect(raw).toContain("inspection.result_shared");
    expect(raw).toContain('"summaryPresent":true');
    expect(raw).not.toContain('"question"');
  });

  it("records session.created and invite.created without invite plaintext", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-audit-session-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const manager = new SessionManager({ stateStore: store, skipPeerHealthPreflight: true });
    const created = await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:47002"
    });
    await manager.flushAudit();

    const events = await manager.listAuditEvents(20);
    expect(events.some((event) => event.eventType === "session.created")).toBe(true);
    expect(events.some((event) => event.eventType === "invite.created")).toBe(true);

    const raw = await readFile(join(dir, "audit", "events.jsonl"), "utf8");
    expect(raw).not.toContain(created.invite.inviteSecret);
  });

  it("records leave and preserves events across manager restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-audit-leave-"));
    const stateFile = join(dir, "state.json");
    const manager = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: stateFile }),
      skipPeerHealthPreflight: true
    });
    await manager.createSession({
      name: "paul-agent",
      agentUrl: "http://127.0.0.1:47003"
    });
    await manager.leaveSession();
    await manager.flushAudit();

    const reloaded = new SessionManager({
      stateStore: new LocalStateStore({ stateFilePath: stateFile }),
      skipPeerHealthPreflight: true
    });
    const events = await reloaded.listAuditEvents(20);
    expect(events.some((event) => event.eventType === "session.left")).toBe(true);
    expect(events.some((event) => event.eventType === "session.created")).toBe(true);
  });

  it("formats human-readable CLI lines without content fields", async () => {
    const event = buildAuditEvent({
      eventType: "inspection.result_shared",
      actor: { peerName: "kelvin-agent" },
      target: { peerName: "paul-agent" },
      correlation: { requestId: "req_test", threadId: "thr_11111111-1111-4111-8111-111111111111" },
      metadata: buildResultSharedMetadata({
        direction: "outbound",
        summary: SOURCE_CANARY,
        findings: [QUESTION_CANARY],
        references: [{ file: "src/retry.ts" }]
      })
    });
    const human = formatAuditEventHuman(event);
    expect(human).toContain("inspection result_shared");
    expect(human).toContain("kelvin-agent → paul-agent");
    expect(human).toContain("src/retry.ts");
    expect(human).not.toContain(SOURCE_CANARY);
    expect(human).not.toContain(QUESTION_CANARY);
  });

  it("marks audit health degraded after a permanent write failure without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-audit-fail-"));
    const eventsFile = join(dir, "events.jsonl");
    // Create a directory where a file is expected so append fails.
    await mkdir(eventsFile, { recursive: true });
    const log = new AuditLog({ eventsFilePath: eventsFile });
    log.record(buildAuditEvent({ eventType: "session.created", metadata: {} }));
    await log.flush();
    expect(log.getHealth().status).toBe("degraded");
  });
});
