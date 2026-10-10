import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MAX_ARTIFACT_BYTES } from "./constants.js";
import type { ArtifactVerifyResult, TrustedRelease } from "./types.js";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

function assertAllowedArtifactUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new ArtifactError(`Invalid artifact URL: ${urlString}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:") {
    const host = url.hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") {
      return url;
    }
    throw new ArtifactError("HTTP artifact URLs are only allowed on loopback for fixtures");
  }
  if (url.protocol === "file:") {
    return url;
  }
  throw new ArtifactError(`Unsupported artifact URL scheme: ${url.protocol}`);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function verifyLocalArtifact(
  path: string,
  expectedSha256: string,
  maxBytes = MAX_ARTIFACT_BYTES
): Promise<ArtifactVerifyResult> {
  if (!expectedSha256 || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    return { ok: false, reason: "Trusted release manifest is missing a valid artifact checksum." };
  }
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    return {
      ok: false,
      reason: `Artifact unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (size <= 0) {
    return { ok: false, reason: "Artifact is empty or incomplete." };
  }
  if (size > maxBytes) {
    return { ok: false, reason: `Artifact exceeds maximum allowed size (${maxBytes} bytes).` };
  }
  const sha256 = await sha256File(path);
  if (sha256 !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      reason: "Update aborted: artifact checksum does not match the trusted release manifest."
    };
  }
  return { ok: true, sha256, bytes: size, path };
}

export type DownloadArtifactOptions = {
  release: TrustedRelease;
  destinationDir?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
};

/**
 * Download (or copy) an artifact to a temp location and verify SHA256 before return.
 * Never installs; caller must verify again before install if desired.
 */
export async function downloadAndVerifyArtifact(
  options: DownloadArtifactOptions
): Promise<ArtifactVerifyResult> {
  const { release } = options;
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  if (!release.artifactSha256 || !/^[0-9a-f]{64}$/i.test(release.artifactSha256)) {
    return { ok: false, reason: "Trusted release manifest is missing a valid artifact checksum." };
  }

  const url = assertAllowedArtifactUrl(release.artifactUrl);
  const destDir =
    options.destinationDir ?? join(tmpdir(), `aroko-update-${process.pid}-${Date.now()}`);
  await mkdir(destDir, { recursive: true });
  const safeName = basename(release.artifactName).replace(/[^\w.-]+/g, "_");
  const destPath = join(destDir, safeName);

  try {
    if (url.protocol === "file:") {
      const source = fileURLToPath(url);
      const { copyFile } = await import("node:fs/promises");
      await copyFile(source, destPath);
    } else {
      const fetchImpl = options.fetchImpl ?? fetch;
      const timeoutMs = options.timeoutMs ?? 60_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal
        });
        if (!response.ok) {
          throw new ArtifactError(`Artifact HTTP ${response.status}`);
        }
        const lengthHeader = response.headers.get("content-length");
        if (lengthHeader) {
          const length = Number(lengthHeader);
          if (Number.isFinite(length) && length > maxBytes) {
            throw new ArtifactError(`Artifact Content-Length exceeds maximum (${maxBytes} bytes).`);
          }
        }
        if (!response.body) {
          throw new ArtifactError("Artifact response body missing");
        }
        const nodeStream = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream
        );
        let received = 0;
        nodeStream.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            controller.abort();
            throw new ArtifactError(`Artifact exceeded maximum allowed size (${maxBytes} bytes).`);
          }
        });
        await pipeline(nodeStream, createWriteStream(destPath));
      } finally {
        clearTimeout(timer);
      }
    }

    const verified = await verifyLocalArtifact(destPath, release.artifactSha256, maxBytes);
    if (!verified.ok) {
      await rm(destPath, { force: true }).catch(() => undefined);
    }
    return verified;
  } catch (error) {
    await rm(destPath, { force: true }).catch(() => undefined);
    if (error instanceof ArtifactError) {
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason: `Artifact download failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
