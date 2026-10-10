import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  AROKO_PROTOCOL_VERSION,
  AROKO_STATE_SCHEMA_VERSION,
  downloadAndVerifyArtifact,
  evaluateUpdateCheck,
  fetchTrustedChannel,
  findReleaseByVersion,
  formatInstallReview,
  planInstall,
  executeInstallPlan,
  selectCurrentRelease
} from "@pairmesh/client";
import { flagValue } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { readArokoBuildInfo, readCliVersion } from "../version.js";

const execFileAsync = promisify(execFile);

async function probeInstalledVersion(prefix?: string): Promise<string> {
  const bin = prefix ? join(prefix, "bin", "aroko") : "aroko";
  const { stdout } = await execFileAsync(bin, ["--version"], {
    env: prefix
      ? { ...process.env, PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}` }
      : process.env,
    encoding: "utf8"
  });
  return stdout.trim().split(/\s+/).pop() ?? stdout.trim();
}

async function confirmInstall(prompt: string, flags: Record<string, string>): Promise<boolean> {
  if (flags.yes === "true") {
    return true;
  }
  if (!input.isTTY || !output.isTTY) {
    console.error("Refusing to install without explicit --yes in non-interactive mode.");
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function runUpdateCheckCommand(flags: Record<string, string> = {}): Promise<void> {
  const installedVersion = readCliVersion();
  const json = flags.json === "true";
  try {
    const channel = await fetchTrustedChannel({ url: flagValue(flags, "channel") });
    const available = selectCurrentRelease(channel);
    const result = evaluateUpdateCheck({ installedVersion, available });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
    }
    if (result.status === "unable-to-verify") {
      process.exitCode = 1;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(
        JSON.stringify(
          {
            status: "unable-to-verify",
            installedVersion,
            message: `Unable to verify updates: ${reason}`,
            reason
          },
          null,
          2
        )
      );
    } else {
      console.error(`Unable to verify updates: ${reason}`);
    }
    process.exitCode = 1;
  }
}

export async function runUpdateInstallCommand(flags: Record<string, string> = {}): Promise<void> {
  const explicitVersion = flagValue(flags, "version");
  const allowDowngrade = flags["force-downgrade"] === "true" || Boolean(explicitVersion);
  const prefix = flagValue(flags, "prefix");
  const installedVersion = readCliVersion();

  let channel;
  try {
    channel = await fetchTrustedChannel({ url: flagValue(flags, "channel") });
  } catch (error) {
    console.error(
      `Unable to verify updates: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
    return;
  }

  const target = explicitVersion
    ? findReleaseByVersion(channel, explicitVersion)
    : selectCurrentRelease(channel);
  if (!target) {
    console.error(
      `Unable to verify updates: Requested version ${explicitVersion} is not in the trusted release channel.`
    );
    process.exitCode = 1;
    return;
  }

  if (target.version === installedVersion && !explicitVersion) {
    console.log(`Aroko ${installedVersion} is already installed.`);
    return;
  }

  const info = readArokoBuildInfo();
  const download = await downloadAndVerifyArtifact({ release: target });
  if (!download.ok) {
    console.error(download.reason);
    process.exitCode = 1;
    return;
  }

  const planned = planInstall({
    installedVersion,
    installedProtocolVersion: info.protocolVersion ?? AROKO_PROTOCOL_VERSION,
    installedStateSchemaVersion: info.stateSchemaVersion ?? AROKO_STATE_SCHEMA_VERSION,
    target,
    verifiedArtifactPath: download.path,
    allowDowngrade
  });
  if (!planned.ok) {
    console.error(planned.reason);
    process.exitCode = 1;
    return;
  }

  console.log(
    formatInstallReview({
      installedVersion,
      target,
      isDowngrade: planned.plan.isDowngrade
    }).replace(/\nInstall Aroko .*\? \[y\/N\]$/, "")
  );

  const approved = await confirmInstall(`\nInstall Aroko ${target.version}? [y/N] `, flags);
  if (!approved) {
    console.log("Update postponed. Installation unchanged.");
    return;
  }

  const outcome = await executeInstallPlan({
    plan: planned.plan,
    prefix,
    versionProbe: probeInstalledVersion
  });
  if (!outcome.ok) {
    console.error(outcome.reason);
    process.exitCode = 1;
    return;
  }

  console.log(`Installed Aroko ${outcome.installedVersion}.`);
  console.log(`Verify with: ${cliBinaryLabel()} version`);
  console.log(
    "If a local runtime is running, the next start/doctor command will reconcile CLI↔runtime."
  );
}

export async function runUpdateHelp(): Promise<void> {
  const bin = cliBinaryLabel();
  console.log(
    [
      "Owner-controlled software updates (local only).",
      "",
      "Usage:",
      `  ${bin} update check [--channel <url>] [--json]`,
      `  ${bin} update [--channel <url>] [--version <semver>] [--yes] [--force-downgrade] [--prefix <path>]`,
      "",
      "Peers, MCP tools, and A2A skills cannot trigger updates.",
      "Set AROKO_RELEASE_CHANNEL_URL to a trusted channel document."
    ].join("\n")
  );
}

export async function runUpdateCommand(
  subcommand: string | undefined,
  flags: Record<string, string> = {}
): Promise<void> {
  if (!subcommand || subcommand === "install") {
    await runUpdateInstallCommand(flags);
    return;
  }
  if (subcommand === "check") {
    await runUpdateCheckCommand(flags);
    return;
  }
  if (subcommand === "help") {
    await runUpdateHelp();
    return;
  }
  throw new Error(`Unknown update command. Try: ${cliBinaryLabel()} update check`);
}
