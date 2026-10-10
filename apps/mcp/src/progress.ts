import type { ServerContext } from "@modelcontextprotocol/server";

export async function emitSafeProgressIfSupported(
  ctx: ServerContext | undefined,
  input: { progress: number; total?: number; message: string }
): Promise<boolean> {
  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  if (progressToken === undefined || progressToken === null) {
    return false;
  }

  await ctx!.mcpReq.notify({
    method: "notifications/progress",
    params: {
      progressToken,
      progress: input.progress,
      ...(input.total !== undefined ? { total: input.total } : {}),
      message: input.message
    }
  });
  return true;
}
