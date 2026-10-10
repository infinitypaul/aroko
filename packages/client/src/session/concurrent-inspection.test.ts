import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createExecutionRecord, findExecutionRecord } from "../inspect/execution-store.js";
import { createInitiatorThreadRecord } from "../inspect/thread-store.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "./manager.js";

describe("concurrent inspection state (Stage 14 Prompt 5)", () => {
  it("mutate queue prevents concurrent state lost updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-mutate-queue-"));
    const store = new LocalStateStore({ stateFilePath: join(dir, "state.json") });
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul-agent", agentUrl: "http://127.0.0.1:14701" });

    const requestIds = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.mutate(async (state) => {
          const peerId = state.localParticipant.participant.id;
          const threadRecord = createInitiatorThreadRecord({
            state,
            targetPeerName: `peer-${index}`,
            targetPeerId: peerId,
            topic: `topic-${index}`
          });
          state.inspectionThreads.push(threadRecord);
          const execution = createExecutionRecord({
            threadId: threadRecord.thread.id,
            peerId,
            peerName: threadRecord.targetPeerName,
            turnNumber: 1,
            question: `question-${index}`,
            requestId: undefined,
            peerAgentUrl: `http://127.0.0.1:${14710 + index}`
          });
          state.inspectionExecutions.unshift(execution);
          return execution.requestId;
        })
      )
    );

    expect(requestIds).toHaveLength(20);
    expect(new Set(requestIds).size).toBe(20);

    const loaded = await store.load();
    expect(loaded?.inspectionThreads).toHaveLength(20);
    expect(loaded?.inspectionExecutions).toHaveLength(20);
    for (const requestId of requestIds) {
      expect(findExecutionRecord(loaded!, requestId)).toBeDefined();
    }
  });
});
