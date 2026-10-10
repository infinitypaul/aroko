import { readArokoBuildInfo, readCliVersion } from "../version.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function runVersionCommand(flags: Record<string, string> = {}): Promise<void> {
  const json = flags.json === "true" || flags.json !== undefined;
  const verbose = flags.verbose === "true" || flags.verbose !== undefined;

  if (json || verbose) {
    const info = readArokoBuildInfo();
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  const info = readArokoBuildInfo();
  const bin = cliBinaryLabel();
  const lines = [
    `${info.product ?? "Aroko"} ${info.version}`,
    `release: ${info.releaseId ?? "unknown"}`,
    `commit:  ${(info.gitCommit ?? "unknown").slice(0, 12)}`,
    `protocol: ${info.protocolVersion ?? "unknown"}`,
    `state:    ${info.stateSchemaVersion ?? "unknown"}`,
    `mode:     ${info.buildMode ?? "unknown"}`
  ];
  if (info.gitTag) {
    lines.splice(2, 0, `tag:     ${info.gitTag}`);
  }
  if (info.artifactSha256) {
    lines.push(`artifact: ${info.artifactSha256.slice(0, 12)}…`);
  }
  lines.push(`cli:      ${bin} (${readCliVersion()})`);
  console.log(lines.join("\n"));
}

export function resolveInstalledCliPath(): string {
  try {
    return realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return fileURLToPath(import.meta.url);
  }
}
