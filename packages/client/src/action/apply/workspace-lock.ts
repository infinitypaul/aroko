/**
 * Serialize repository.edit applies per resolved workspace root.
 * Independent workspaces do not share this lock.
 */
const tails = new Map<string, Promise<void>>();

export async function withWorkspaceApplyLock<T>(
  workspaceRoot: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = tails.get(workspaceRoot) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => hold);
  tails.set(
    workspaceRoot,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
