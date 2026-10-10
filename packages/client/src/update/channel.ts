import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_CHANNEL_URL_ENV } from "./constants.js";
import { ChannelManifestError, parseTrustedChannelDocument } from "./manifest.js";
import type { TrustedChannelDocument } from "./types.js";

export function resolveReleaseChannelUrl(
  env: NodeJS.ProcessEnv = process.env,
  override?: string
): string | undefined {
  if (override?.trim()) {
    return override.trim();
  }
  for (const key of RELEASE_CHANNEL_URL_ENV) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function assertAllowedChannelUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new ChannelManifestError(`Invalid release channel URL: ${urlString}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:") {
    const host = url.hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") {
      return url;
    }
    throw new ChannelManifestError(
      "HTTP release channels are only allowed on loopback for fixtures"
    );
  }
  if (url.protocol === "file:") {
    return url;
  }
  throw new ChannelManifestError(`Unsupported release channel URL scheme: ${url.protocol}`);
}

export type FetchChannelOptions = {
  url?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function fetchTrustedChannel(
  options: FetchChannelOptions = {}
): Promise<TrustedChannelDocument> {
  const urlString = resolveReleaseChannelUrl(options.env ?? process.env, options.url);
  if (!urlString) {
    throw new ChannelManifestError(
      "No trusted release channel configured. Set AROKO_RELEASE_CHANNEL_URL to a verified channel endpoint."
    );
  }
  const url = assertAllowedChannelUrl(urlString);

  let body: string;
  if (url.protocol === "file:") {
    const filePath = fileURLToPath(url);
    try {
      body = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new ChannelManifestError(
        `Unable to read release channel file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new ChannelManifestError(`Release channel HTTP ${response.status}`);
      }
      body = await response.text();
    } catch (error) {
      if (error instanceof ChannelManifestError) {
        throw error;
      }
      throw new ChannelManifestError(
        `Unable to fetch release channel: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ChannelManifestError("Release channel returned malformed JSON");
  }
  return parseTrustedChannelDocument(parsed);
}

/** Helper for tests constructing file:// channel URLs. */
export function channelFileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}
