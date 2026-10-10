import { createInterface } from "node:readline";
import {
  collaborateAsk,
  formatAmbiguousPeerChoices,
  formatAmbiguousPeerPrompt,
  resolveCollaborateIntent,
  type CollaborateAskIntent,
  type CollaborateAskResult
} from "@pairmesh/client";
import { flagValue } from "../args.js";
import { cliBinaryLabel } from "../cli-brand.js";
import { createSessionManagerFromResolvedConfig } from "../context.js";
import { resolveCommandWorkspace } from "../workspace.js";

/**
 * Everyday: ask <peer> "request text" [--propose|--inspect|--goal] [--wait-ms N] [--json]
 */
export async function runAskCommand(
  flags: Record<string, string>,
  positionals: string[] = []
): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace);
  const manager = await createSessionManagerFromResolvedConfig(workspace);

  const peerRef = positionals[0];
  const requestText = positionals.slice(1).join(" ").trim() || flagValue(flags, "request");
  if (!peerRef || !requestText) {
    const bin = cliBinaryLabel();
    throw new Error(
      [
        "Usage:",
        `  ${bin} ask <peer> "Check why payment retries lose the reference"`,
        `  ${bin} ask "Kelvin · payment-service" --propose "Fix the retry reference"`,
        `  ${bin} ask Kelvin --goal "Prepare this project for package X"`,
        "",
        "Default intent is inspect (read-only). Use --propose for a change suggestion",
        "(owner still Approves Once). Use --goal for collaborative orchestration.",
        "Use --inspect to force investigation."
      ].join("\n")
    );
  }

  let force: CollaborateAskIntent | undefined;
  if (flags.goal === "true") {
    force = "goal";
  } else if (flags.propose === "true" || flags.fix === "true") {
    force = "propose";
  } else if (flags.inspect === "true") {
    force = "inspect";
  }

  const intentResolved = resolveCollaborateIntent({ request: requestText, force });
  if ("clarify" in intentResolved) {
    console.log(intentResolved.clarify);
    process.exitCode = 2;
    return;
  }

  const waitMs = Number(flagValue(flags, "wait-ms") ?? "60000");
  let result = await collaborateAsk(manager, {
    peerRef,
    request: requestText,
    intent: intentResolved.intent,
    waitMs: Number.isFinite(waitMs) ? waitMs : 60_000
  });

  if (!result.ok && result.code === "peer_ambiguous") {
    const picked = await pickAmbiguous(result.matches);
    if (!picked) {
      console.log(result.presentation);
      process.exitCode = 2;
      return;
    }
    result = await collaborateAsk(manager, {
      peerRef: picked.participantId,
      request: requestText,
      intent: intentResolved.intent,
      waitMs: Number.isFinite(waitMs) ? waitMs : 60_000
    });
  }

  if (flags.json === "true") {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  printHuman(result);
  if (!result.ok) {
    process.exitCode = result.code === "peer_ambiguous" ? 2 : 1;
    return;
  }
}

function printHuman(result: CollaborateAskResult): void {
  if (!result.ok) {
    console.log(result.presentation);
    return;
  }
  console.log(`Resolved ${result.peer.label}`);
  if (result.intent === "inspect") {
    console.log("Sending investigation...");
  } else if (result.intent === "propose") {
    console.log("Sending change proposal request...");
  } else {
    console.log("Starting collaborative goal...");
  }
  console.log("");
  console.log(result.presentation);
}

async function pickAmbiguous(
  matches: Array<{ displayName: string; service?: string; participantId: string; label: string }>
): Promise<{ participantId: string } | null> {
  const choices = formatAmbiguousPeerChoices(matches);
  console.log(formatAmbiguousPeerPrompt(choices));
  if (!process.stdin.isTTY) {
    return null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("> ", (value) => {
      rl.close();
      resolve(value.trim());
    });
  });
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > choices.length) {
    console.log("Cancelled.");
    return null;
  }
  return { participantId: choices[index - 1]!.participantId };
}
