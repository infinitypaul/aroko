import { createPairMeshError } from "@pairmesh/protocol";

/** Per-workspace concurrency gate for tests.run (default max 1). */
export class TestsRunConcurrencyGate {
  private readonly active = new Map<string, number>();

  public async acquire(workspaceRoot: string, maxConcurrent: number): Promise<() => void> {
    const limit = Math.max(1, Math.min(4, maxConcurrent));
    const current = this.active.get(workspaceRoot) ?? 0;
    if (current >= limit) {
      throw createPairMeshError({
        code: "pairmesh.test_execution_busy",
        message: `tests.run concurrency limit (${limit}) reached for this workspace.`
      });
    }
    this.active.set(workspaceRoot, current + 1);
    return () => {
      const next = Math.max(0, (this.active.get(workspaceRoot) ?? 1) - 1);
      if (next === 0) {
        this.active.delete(workspaceRoot);
      } else {
        this.active.set(workspaceRoot, next);
      }
    };
  }
}
