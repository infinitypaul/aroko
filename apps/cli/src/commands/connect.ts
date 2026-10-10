import { createInterface } from "node:readline";
import { flagValue } from "../args.js";
import { cliBinaryLabel, productDisplayName } from "../cli-brand.js";
import { resolveCommandWorkspace } from "../workspace.js";
import { runCreateCommand, runJoinCommand, runInviteCommand } from "./session.js";
import { runStartCommand } from "./start.js";
import { readRuntimeInfo, requireActiveRuntime } from "@pairmesh/client";

/**
 * Everyday connect: reduce create/join/invite/start choreography with explicit choices.
 * Never silently grants capabilities.
 */
export async function runConnectCommand(flags: Record<string, string>): Promise<void> {
  const workspace = await resolveCommandWorkspace(flagValue(flags, "workspace"));
  const bin = cliBinaryLabel();
  const product = productDisplayName();
  const { ensureRuntimeUpgradeForCommand } = await import("../runtime/upgrade-handshake.js");
  await ensureRuntimeUpgradeForCommand(workspace);

  let runtimeInfo = await readRuntimeInfo(workspace);
  if (!runtimeInfo) {
    console.log(`${product} is not running.`);
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Start ${product} now? [y/N] `, (value) => {
          rl.close();
          resolve(value.trim().toLowerCase());
        });
      });
      if (answer === "y" || answer === "yes") {
        await runStartCommand({ ...flags, workspace });
        runtimeInfo = await readRuntimeInfo(workspace);
      } else {
        console.log(`Run \`${bin} start\` when ready, then \`${bin} connect\` again.`);
        return;
      }
    } else {
      console.log(`Run: ${bin} start`);
      return;
    }
  }

  try {
    await requireActiveRuntime(workspace);
  } catch {
    console.log(`Runtime info present but process not healthy. Try: ${bin} doctor`);
  }

  if (!process.stdin.isTTY) {
    console.log(
      [
        "Non-interactive connect. Use:",
        `  ${bin} create`,
        `  ${bin} join <code> --invite <secret> [--peer <url>]`,
        `  ${bin} invite`
      ].join("\n")
    );
    return;
  }

  console.log(product);
  console.log("");
  console.log("What would you like to do?");
  console.log("");
  console.log("1. Start a collaboration");
  console.log("2. Join a collaboration");
  console.log("3. Invite another teammate");
  console.log("4. Cancel");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise<string>((resolve) => {
    rl.question("> ", (value) => {
      rl.close();
      resolve(value.trim());
    });
  });

  if (choice === "1") {
    console.log("");
    console.log("Permissions stay explicit — create uses invite initial grant defaults.");
    console.log(`Widen later with: ${bin} permissions`);
    await runCreateCommand(flags);
    return;
  }
  if (choice === "2") {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const joinLine = await new Promise<string>((resolve) => {
      rl2.question("Paste join command or session code: ", (value) => {
        rl2.close();
        resolve(value.trim());
      });
    });
    if (joinLine.includes("join")) {
      // Parse: aroko|pairmesh join CODE --invite SECRET [--peer URL]
      const tokens = joinLine.split(/\s+/);
      const joinIdx = tokens.indexOf("join");
      const code = tokens[joinIdx + 1];
      let invite = "";
      let peer = "";
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i] === "--invite") invite = tokens[i + 1] ?? "";
        if (tokens[i] === "--peer") peer = tokens[i + 1] ?? "";
      }
      if (!code || !invite) {
        throw new Error("Could not parse join command. Need session code and --invite.");
      }
      await runJoinCommand(code, {
        ...flags,
        invite,
        ...(peer ? { peer } : {})
      });
      return;
    }
    const rl3 = createInterface({ input: process.stdin, output: process.stdout });
    const invite = await new Promise<string>((resolve) => {
      rl3.question("Invite secret: ", (value) => {
        rl3.close();
        resolve(value.trim());
      });
    });
    const rl4 = createInterface({ input: process.stdin, output: process.stdout });
    const peer = await new Promise<string>((resolve) => {
      rl4.question("Peer URL (blank if relay): ", (value) => {
        rl4.close();
        resolve(value.trim());
      });
    });
    await runJoinCommand(joinLine, {
      ...flags,
      invite,
      ...(peer ? { peer } : {})
    });
    return;
  }
  if (choice === "3") {
    await runInviteCommand(undefined, [], flags);
    return;
  }
  console.log("Cancelled.");
}
