#!/usr/bin/env node
import { PairMeshClientBootstrap, PairMeshProjectNotFoundError } from "@pairmesh/client";
import { PairMeshErrorSchema } from "@pairmesh/protocol";
import { parseArgs } from "./args.js";
import { cliBinaryLabel, detectCliInvocationName, productDisplayName } from "./cli-brand.js";
import { runInitCommand } from "./commands/init.js";
import { runStartCommand } from "./commands/start.js";
import { runStopCommand } from "./commands/stop.js";
import { runRestartCommand } from "./commands/restart.js";
import { runLogsCommand } from "./commands/logs.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runMcpCommand } from "./commands/mcp.js";
import { runCursorSetupCommand } from "./commands/cursor-setup.js";
import { runClaudeSetupCommand } from "./commands/claude-setup.js";
import {
  runConfigHelp,
  runConfigSetCommand,
  runConfigShowCommand,
  runConfigUnsetCommand
} from "./commands/config.js";
import { runAuditCommand } from "./commands/audit.js";
import { runPermissionsCommand } from "./commands/permissions.js";
import { runActionCommand } from "./commands/action.js";
import { runTaskCommand } from "./commands/task.js";
import { runControlCommand } from "./commands/control.js";
import { runRelayCommand } from "./commands/relay.js";
import { runAskCommand } from "./commands/ask.js";
import { runConnectCommand } from "./commands/connect.js";
import { runOpenCommand } from "./commands/open.js";
import { runRequestsCommand } from "./commands/requests.js";
import { runWatchCommand } from "./commands/watch.js";
import {
  runCreateCommand,
  runInviteCommand,
  runJoinCommand,
  runLeaveCommand,
  runPeerCommand,
  runPeersCommand,
  runSendCommand,
  runStatusCommand
} from "./commands/session.js";

import { assertSupportedNodeVersion, readCliVersion, readArokoBuildInfo } from "./version.js";
import { runVersionCommand } from "./commands/version.js";
import { runUpdateCommand } from "./commands/update.js";

export function renderBanner(): string {
  const bootstrap = new PairMeshClientBootstrap();
  const boundaryOk = bootstrap.validateProtocolBoundary();
  const status = boundaryOk ? "Protocol boundary ready." : "Protocol boundary misconfigured.";
  return `${productDisplayName()}\nPair programming, agent to agent.\n${status}`;
}

function renderHelp(): string {
  const bin = cliBinaryLabel();
  return [
    renderBanner(),
    "",
    "Usage:",
    `  ${bin} --version`,
    `  ${bin} version [--json]`,
    `  ${bin} update check [--channel <url>]`,
    `  ${bin} update [--version <semver>] [--yes]`,
    `  ${bin} init [--name <agent-name>] [--port auto|47102]`,
    `  ${bin} start [--foreground|-f] [--host <bind-host>]`,
    `  ${bin} stop [--force]`,
    `  ${bin} restart [--force]`,
    `  ${bin} logs`,
    `  ${bin} doctor`,
    `  ${bin} mcp [--check] [--print-config] [--client claude-desktop|cursor|generic]`,
    `  ${bin} cursor setup [--write] [--force]`,
    `  ${bin} claude setup [--write] [--force]`,
    `  ${bin} config show`,
    `  ${bin} config set --key <key> --value <value>`,
    `  ${bin} config unset --key <key>`,
    "",
    "Everyday:",
    `  ${bin} connect`,
    `  ${bin} ask <peer> "request" [--inspect|--propose|--goal]`,
    `  ${bin} requests`,
    `  ${bin} watch`,
    `  ${bin} status [--json] [--verbose]`,
    `  ${bin} open`,
    "",
    "Session / power:",
    `  ${bin} create [--json]`,
    `  ${bin} invite`,
    `  ${bin} invite list [--json]`,
    `  ${bin} invite revoke <invitationId>`,
    `  ${bin} join <session-code> --invite <invite-secret>`,
    `  ${bin} join <session-code> --peer <url> --invite <invite-secret>`,
    `  ${bin} peers [--json]`,
    `  ${bin} peer remove <ref>`,
    `  ${bin} peer pair --invite <secret> --peer-url <url>`,
    `  ${bin} leave`,
    `  ${bin} send --peer <peer> <message>`,
    `  ${bin} audit [--json] [--limit <n>]`,
    `  ${bin} permissions [--peer <name>]`,
    `  ${bin} permissions pending`,
    `  ${bin} permissions grant|revoke|require-approval <peer> <capability>`,
    `  ${bin} permissions approve <id> --once|--session`,
    `  ${bin} permissions deny <id>`,
    `  ${bin} action pending|list|get|review|approve|deny|wait|cancel …`,
    `  ${bin} action propose|apply|test --peer <peer> …`,
    `  ${bin} control status [--json] [--show-token]`,
    `  ${bin} control open`,
    "",
    "Quick start:",
    `  ${bin} init`,
    `  ${bin} cursor setup --write`,
    `  ${bin} connect`,
    ...(detectCliInvocationName() === "pairmesh"
      ? ["", "Note: `pairmesh` is a temporary compatibility alias for `aroko`."]
      : [])
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const argv = process.argv.slice(2).filter((token) => token !== "--");
  const { command, subcommand, positionals, flags } = parseArgs(argv);

  // Top-level only — do not intercept `update --version <semver>`.
  if (!command && (argv.includes("--version") || argv.includes("-v"))) {
    if (argv.includes("--verbose")) {
      console.log(JSON.stringify(readArokoBuildInfo(), null, 2));
    } else {
      console.log(readCliVersion());
    }
    return;
  }

  if (!command) {
    console.log(renderHelp());
    return;
  }

  try {
    switch (command) {
      case "init":
        await runInitCommand(flags);
        break;
      case "start":
        await runStartCommand(flags);
        break;
      case "stop":
        await runStopCommand(flags);
        break;
      case "restart":
        await runRestartCommand(flags);
        break;
      case "logs":
        await runLogsCommand(flags);
        break;
      case "doctor":
        await runDoctorCommand(flags);
        break;
      case "version":
        await runVersionCommand(flags);
        break;
      case "update":
        await runUpdateCommand(subcommand, flags);
        break;
      case "mcp":
        await runMcpCommand(flags);
        break;
      case "cursor":
        if (subcommand === "setup") {
          await runCursorSetupCommand(flags);
        } else {
          throw new Error(`Unknown cursor command. Usage: ${cliBinaryLabel()} cursor setup`);
        }
        break;
      case "claude":
        if (subcommand === "setup") {
          await runClaudeSetupCommand(flags);
        } else {
          throw new Error(
            `Unknown claude command. Usage: ${cliBinaryLabel()} claude setup [--write]`
          );
        }
        break;
      case "config":
        if (subcommand === "show") {
          await runConfigShowCommand();
        } else if (subcommand === "set") {
          await runConfigSetCommand(flags);
        } else if (subcommand === "unset") {
          await runConfigUnsetCommand(flags);
        } else {
          runConfigHelp(subcommand);
        }
        break;
      case "connect":
        await runConnectCommand(flags);
        break;
      case "ask":
        await runAskCommand(flags, positionals);
        break;
      case "requests":
        await runRequestsCommand(flags, positionals);
        break;
      case "watch":
        await runWatchCommand(flags);
        break;
      case "open":
        await runOpenCommand(flags, positionals);
        break;
      case "create":
        await runCreateCommand(flags);
        break;
      case "invite":
        await runInviteCommand(subcommand, positionals, flags);
        break;
      case "join":
        if (!positionals[0]) {
          throw new Error(
            `Missing session code. Usage: ${cliBinaryLabel()} join <session-code> --peer <url> --invite <invite-secret>`
          );
        }
        await runJoinCommand(positionals[0], flags);
        break;
      case "status":
        await runStatusCommand(flags);
        break;
      case "peers":
        await runPeersCommand(flags);
        break;
      case "peer":
        await runPeerCommand(subcommand, positionals, flags);
        break;
      case "leave":
        await runLeaveCommand(flags);
        break;
      case "send":
        await runSendCommand(flags, positionals.join(" "));
        break;
      case "audit":
        await runAuditCommand(flags, positionals);
        break;
      case "permissions":
        await runPermissionsCommand(flags, positionals, subcommand);
        break;
      case "action":
        await runActionCommand(flags, positionals, subcommand);
        break;
      case "task":
        await runTaskCommand(flags, positionals, subcommand);
        break;
      case "control":
        await runControlCommand(flags, positionals, subcommand);
        break;
      case "relay":
        await runRelayCommand(flags, positionals, subcommand);
        break;
      default:
        console.log(renderHelp());
    }
  } catch (error) {
    if (error instanceof PairMeshProjectNotFoundError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    if (PairMeshErrorSchema.safeParse(error).success) {
      console.error(JSON.stringify(error, null, 2));
      process.exitCode = 1;
      return;
    }

    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
