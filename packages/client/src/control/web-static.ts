import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

function resolveControlWebRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const distAdjacent = join(moduleDir, "..", "control-web");
  if (existsSync(join(distAdjacent, "index.html"))) {
    return distAdjacent;
  }
  return join(moduleDir, "..", "..", "control-web");
}

const WEB_ROOT = resolveControlWebRoot();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

export function resolveControlWebPath(urlPath: string): string | undefined {
  let relative = urlPath.replace(/^\/+/, "");
  if (
    !relative ||
    relative === "inbox" ||
    relative === "activity" ||
    relative === "history" ||
    relative === "home" ||
    relative === "people" ||
    relative === "live" ||
    relative === "needs-you" ||
    relative === "settings"
  ) {
    relative = "index.html";
  }
  if (relative.includes("..")) {
    return undefined;
  }
  const normalized = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!normalized || normalized.startsWith("..")) {
    return undefined;
  }
  return join(WEB_ROOT, normalized);
}

export async function serveControlWebAsset(urlPath: string, res: ServerResponse): Promise<boolean> {
  const filePath = resolveControlWebPath(urlPath);
  if (!filePath || !filePath.startsWith(WEB_ROOT)) {
    return false;
  }
  try {
    const body = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
    return true;
  } catch {
    return false;
  }
}
