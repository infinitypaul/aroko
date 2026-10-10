/** Per-workspace concurrency gate for process.execute (default max 1). */
import { createPairMeshError } from "@pairmesh/protocol";

export class ProcessExecuteConcurrencyGate {
  private active = 0;

  public async acquire(limit: number): Promise<() => void> {
    if (this.active >= limit) {
      throw createPairMeshError({
        code: "pairmesh.process_execution_busy",
        message: `process.execute concurrency limit (${limit}) reached for this workspace.`
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}
