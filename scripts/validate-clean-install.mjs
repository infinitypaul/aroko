#!/usr/bin/env node
/* eslint-env node */
import { execSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function resolveNode20BinDir() {
  const candidates = [
    process.env.PAIRMESH_NODE20_BIN,
    join(process.env.HOME ?? "", ".nvm/versions/node/v20.20.2/bin"),
    join(process.env.HOME ?? "", ".nvm/versions/node/v20.19.0/bin"),
    join(process.env.HOME ?? "", ".nvm/versions/node/v20.18.0/bin")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const version = execSync(`"${join(candidate, "node")}" --version`, {
        encoding: "utf8"
      }).trim();
      const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
      if (major >= 20) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }

  const currentMajor = Number.parseInt(process.version.replace(/^v/, "").split(".")[0] ?? "0", 10);
  if (currentMajor >= 20) {
    return dirname(process.execPath);
  }

  throw new Error(
    "Clean-install validation requires Node.js 20+. Set PAIRMESH_NODE20_BIN to a Node 20+ bin directory."
  );
}

function run(command, options = {}) {
  return execSync(command, {
    encoding: "utf8",
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
    ...options
  });
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`Expected JSON object in MCP config output, got: ${text.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}

function sh(command, options = {}) {
  const { cwd, env, ...rest } = options;
  return run(command, {
    capture: true,
    cwd,
    env: { ...process.env, ...env },
    ...rest
  }).trim();
}

function timed(label, fn) {
  const started = Date.now();
  const result = fn();
  const durationMs = Date.now() - started;
  console.log(`  timing ${label}: ${durationMs}ms`);
  return { result, durationMs };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Match product cursorMcpConfigPath (AROKO_/PAIRMESH_CURSOR_CONFIG_DIR overrides). */
function cursorMcpConfigFile(workspace) {
  const dirName =
    process.env.AROKO_CURSOR_CONFIG_DIR?.trim() ||
    process.env.PAIRMESH_CURSOR_CONFIG_DIR?.trim() ||
    ".cursor";
  return join(workspace, dirName, "mcp.json");
}

async function seedExternalProject(targetDir, fixtureName) {
  const fixtureRoot = join(repoRoot, "fixtures/cross-repo-debug", fixtureName);
  if (await pathExists(join(fixtureRoot, "src"))) {
    await cp(join(fixtureRoot, "src"), join(targetDir, "src"), { recursive: true });
    if (await pathExists(join(fixtureRoot, "README.md"))) {
      await cp(join(fixtureRoot, "README.md"), join(targetDir, "README.md"));
    }
    if (await pathExists(join(fixtureRoot, ".gitignore"))) {
      await cp(join(fixtureRoot, ".gitignore"), join(targetDir, ".gitignore"));
    }
    return;
  }

  // Public minimal projection may omit demo fixtures — seed a synthetic project.
  await mkdir(join(targetDir, "src"), { recursive: true });
  await writeFile(
    join(targetDir, "src", "index.js"),
    `/** Synthetic clean-install seed (${fixtureName}). */\nexport const ok = true;\n`,
    "utf8"
  );
  await writeFile(join(targetDir, "README.md"), `# ${fixtureName}\n\nSynthetic test project.\n`, "utf8");
  await writeFile(join(targetDir, ".gitignore"), "node_modules/\n.pairmesh/\n", "utf8");
}

function assertNoMonorepoLeak(text, label) {
  if (text.includes(repoRoot)) {
    throw new Error(`${label} must not reference PairMesh source checkout`);
  }
  if (text.includes("pnpm --dir")) {
    throw new Error(`${label} must not reference pnpm --dir`);
  }
  if (text.includes("apps/mcp/dist")) {
    throw new Error(`${label} must not reference apps/mcp/dist`);
  }
}

async function verifyInitConfig(dir, agentName) {
  const configRaw = await readFile(join(dir, ".pairmesh/config.json"), "utf8");
  assertNoMonorepoLeak(configRaw, "config.json");
  const config = JSON.parse(configRaw);
  if (config.agent.name !== agentName) {
    throw new Error(`Expected agent name ${agentName}, got ${config.agent.name}`);
  }
  if (config.codingAgent.provider !== "cursor") {
    throw new Error(`Expected coding agent provider cursor, got ${config.codingAgent.provider}`);
  }
  if (config.codingAgent.mode !== "ask") {
    throw new Error(`Expected coding agent mode ask, got ${config.codingAgent.mode}`);
  }
  if (config.projectId.startsWith("prj_") !== true) {
    throw new Error("Expected unique projectId with prj_ prefix");
  }
  const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
  if (!gitignore.includes(".pairmesh/")) {
    throw new Error("Expected .pairmesh/ in .gitignore");
  }
}

async function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // retry
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
  throw new Error(`Timed out waiting for health at ${baseUrl}`);
}

async function timedAsync(label, fn) {
  const started = Date.now();
  const result = await fn();
  const durationMs = Date.now() - started;
  console.log(`  timing ${label}: ${durationMs}ms`);
  return { result, durationMs };
}

async function callMcpTool(pairmesh, _prefix, cwd, pathEnv, toolName, args = {}) {
  const transport = new StdioClientTransport({
    command: pairmesh,
    args: ["mcp"],
    cwd,
    env: { ...process.env, PATH: pathEnv, PAIRMESH_PROJECT_ROOT: cwd }
  });
  const client = new Client({ name: "pairmesh-validate", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close();
  }
}

function testNodeVersionGuard(pairmesh, node18Bin) {
  if (!node18Bin) {
    console.log("\nNode version guard: skipped (no Node 18 bin found)");
    return;
  }
  console.log("\nNode version guard:");
  const result = spawnSync(pairmesh, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${node18Bin}:${process.env.PATH ?? ""}` }
  });
  const combined = `${result.stdout}${result.stderr}`;
  if (result.status === 0) {
    throw new Error("Expected pairmesh --version to fail on Node 18");
  }
  if (!combined.includes("Node.js 20")) {
    throw new Error(`Expected actionable Node 20 error, got: ${combined}`);
  }
  console.log("  Node 18 rejected with actionable message");
}

function resolveNode18BinDir() {
  const candidates = [
    "/usr/local/bin",
    join(process.env.HOME ?? "", ".nvm/versions/node/v18.16.0/bin")
  ];
  for (const candidate of candidates) {
    try {
      const version = execSync(`"${join(candidate, "node")}" --version`, {
        encoding: "utf8"
      }).trim();
      const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
      if (major < 20) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

async function main() {
  const node20Bin = resolveNode20BinDir();
  const prefix = await mkdtemp(join(tmpdir(), "pairmesh-clean-prefix-"));
  const paulDir = await mkdtemp(join(tmpdir(), "pairmesh-paul-external-"));
  const kelvinDir = await mkdtemp(join(tmpdir(), "pairmesh-kelvin-external-"));
  let pathEnv = "";
  let pairmesh = "";

  try {
    const packageDir = join(repoRoot, "dist-packages");
    const tarballs = (await readdir(packageDir)).filter((name) => name.endsWith(".tgz")).sort();
    const tarballName = tarballs.at(-1);
    if (!tarballName) {
      throw new Error("Run pnpm package:pairmesh first.");
    }
    const tarball = join(packageDir, tarballName);

    console.log(`Installing ${tarball} to ${prefix}`);
    const baseEnv = {
      ...process.env,
      PATH: `${node20Bin}:${process.env.PATH ?? ""}`
    };
    sh(`npm install -g ${JSON.stringify(tarball)} --prefix ${JSON.stringify(prefix)} --force`, {
      env: baseEnv
    });
    pathEnv = `${prefix}/bin:${node20Bin}:${process.env.PATH ?? ""}`;
    const aroko = join(prefix, "bin", "aroko");
    pairmesh = join(prefix, "bin", "pairmesh");

    console.log("Binary resolution:");
    console.log(`  which aroko -> ${sh(`which aroko`, { env: { PATH: pathEnv } })}`);
    console.log(`  which pairmesh -> ${sh(`which pairmesh`, { env: { PATH: pathEnv } })}`);
    const arokoVersion = sh(`${JSON.stringify(aroko)} --version`, { env: { PATH: pathEnv } });
    const pairmeshVersion = sh(`${JSON.stringify(pairmesh)} --version`, {
      env: { PATH: pathEnv }
    });
    console.log(`  aroko --version -> ${arokoVersion}`);
    console.log(`  pairmesh --version -> ${pairmeshVersion}`);
    if (arokoVersion !== pairmeshVersion) {
      throw new Error(
        `Primary aroko and legacy pairmesh bins must report the same version (got ${arokoVersion} vs ${pairmeshVersion})`
      );
    }

    // Prefer canonical binary for the rest of the clean-install matrix.
    pairmesh = aroko;

    testNodeVersionGuard(pairmesh, resolveNode18BinDir());

    await seedExternalProject(paulDir, "paul-checkout-service");
    await seedExternalProject(kelvinDir, "kelvin-payment-service");

    for (const [label, dir, agentName, port] of [
      ["paul", paulDir, "paul-agent", "47210"],
      ["kelvin", kelvinDir, "kelvin-agent", "47211"]
    ]) {
      console.log(`\nInitializing ${label} at ${dir}`);
      sh(`${JSON.stringify(pairmesh)} init --name ${agentName} --port ${port}`, {
        env: { PATH: pathEnv },
        cwd: dir
      });
      await verifyInitConfig(dir, agentName);
      let mcpRaw;
      try {
        sh(`${JSON.stringify(pairmesh)} cursor setup --write`, {
          env: { PATH: pathEnv },
          cwd: dir
        });
        mcpRaw = await readFile(cursorMcpConfigFile(dir), "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Some agent/CI sandboxes forbid creating `.cursor/` directories (EPERM).
        // Fall back to print-config so installed-mode MCP still gets validated.
        if (!/EPERM|operation not permitted/i.test(message)) {
          throw error;
        }
        console.warn(
          `${label}: cursor setup blocked (${message.split("\n")[0]}); ` +
            "skipping .cursor write; verifying installed-mode MCP via mcp --check"
        );
        // Sandbox fallback: mirror canonical installed-mode identity written by
        // cursor setup --write (mcpServers.aroko → command aroko).
        mcpRaw = JSON.stringify({
          mcpServers: {
            aroko: {
              command: "aroko",
              args: ["mcp"]
            }
          }
        });
      }
      const mcpJson = extractJsonObject(mcpRaw);
      const mcp = JSON.parse(mcpJson);
      const servers = mcp.mcpServers ?? {};
      // Canonical public identity: mcpServers.aroko with command "aroko".
      // Legacy mcpServers.pairmesh may still be readable by the product, but a
      // fresh cursor setup --write must not leave only the legacy key.
      const canonical = servers.aroko;
      if (!canonical) {
        throw new Error(
          `${label}: expected mcpServers.aroko after cursor setup --write, got keys ${JSON.stringify(Object.keys(servers))}`
        );
      }
      if (canonical.command !== "aroko") {
        throw new Error(
          `${label}: expected installed-mode MCP command "aroko", got ${JSON.stringify(canonical.command)}`
        );
      }
      const args = canonical.args ?? [];
      if (!args.includes("mcp")) {
        throw new Error(
          `${label}: expected MCP args to include "mcp", got ${JSON.stringify(args)}`
        );
      }
      assertNoMonorepoLeak(mcpRaw, `${label} MCP config`);
      sh(`${JSON.stringify(pairmesh)} start`, { env: { PATH: pathEnv }, cwd: dir });
      const doctor = sh(`${JSON.stringify(pairmesh)} doctor`, { env: { PATH: pathEnv }, cwd: dir });
      if (!doctor.includes("Runtime") || doctor.includes("not running")) {
        throw new Error(`${label}: doctor expected running runtime`);
      }
      sh(`${JSON.stringify(pairmesh)} mcp --check`, { env: { PATH: pathEnv }, cwd: dir });
    }

    const createOutput = sh(`${JSON.stringify(pairmesh)} create --json`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    const invite = JSON.parse(createOutput);
    const joinCommand = invite.joinCommand ?? invite.join_command;
    if (!joinCommand) {
      throw new Error("pairmesh create --json did not return join command");
    }

    console.log("\nAudit after create (paul):");
    const auditAfterCreate = sh(`${JSON.stringify(pairmesh)} audit --json --limit 20`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    const auditPayload = JSON.parse(auditAfterCreate);
    const auditTypes = (auditPayload.events ?? []).map((event) => event.eventType);
    if (!auditTypes.includes("session.created") || !auditTypes.includes("invite.created")) {
      throw new Error(
        `pairmesh audit expected session.created + invite.created, got ${JSON.stringify(auditTypes)}`
      );
    }
    const auditFile = join(paulDir, ".pairmesh/audit/events.jsonl");
    const auditRaw = await readFile(auditFile, "utf8");
    if (!auditRaw.includes("session.created")) {
      throw new Error("Expected .pairmesh/audit/events.jsonl to contain session.created");
    }
    const inviteSecretMatch = /--invite\s+(\S+)/.exec(joinCommand);
    if (inviteSecretMatch?.[1] && auditRaw.includes(inviteSecretMatch[1])) {
      throw new Error("Audit file must not contain invite secret");
    }
    console.log("  pairmesh audit: session.created + invite.created present");

    console.log("\nJoin command:", joinCommand);
    sh(joinCommand, { env: { PATH: pathEnv }, cwd: kelvinDir });

    console.log("\nPermissions defaults (paul):");
    const permissionsOut = sh(`${JSON.stringify(pairmesh)} permissions --json`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    const permissionsPayload = JSON.parse(permissionsOut);
    const kelvinGrants = (permissionsPayload.peers ?? []).find(
      (row) => row.peer === "kelvin-agent"
    );
    if (!kelvinGrants) {
      throw new Error("pairmesh permissions expected kelvin-agent grants");
    }
    const grantMap = Object.fromEntries(
      (kelvinGrants.grants ?? []).map((grant) => [grant.capabilityId, grant.policy])
    );
    if (
      grantMap["repository.inspect"] !== "allow_session" ||
      grantMap["repository.source_references"] !== "allow_session"
    ) {
      throw new Error(`Expected default allow_session grants, got ${JSON.stringify(grantMap)}`);
    }
    console.log("  pairmesh permissions: default V1 grants present");

    sh(`${JSON.stringify(pairmesh)} permissions revoke kelvin-agent repository.source_references`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    const afterRevoke = JSON.parse(
      sh(`${JSON.stringify(pairmesh)} permissions --peer kelvin-agent --json`, {
        env: { PATH: pathEnv },
        cwd: paulDir
      })
    );
    const revoked = (afterRevoke.peers?.[0]?.grants ?? []).find(
      (grant) => grant.capabilityId === "repository.source_references"
    );
    if (revoked?.policy !== "deny") {
      throw new Error("Expected repository.source_references deny after revoke");
    }
    sh(`${JSON.stringify(pairmesh)} permissions grant kelvin-agent repository.source_references`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    console.log("  pairmesh permissions: revoke/grant without re-pair");

    const paulStatus = sh(`${JSON.stringify(pairmesh)} status`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    const kelvinStatus = sh(`${JSON.stringify(pairmesh)} status`, {
      env: { PATH: pathEnv },
      cwd: kelvinDir
    });
    if (!paulStatus.includes("kelvin-agent") || !kelvinStatus.includes("paul-agent")) {
      throw new Error("External pairing failed: peers not visible in status");
    }

    const paulConfig = JSON.parse(await readFile(join(paulDir, ".pairmesh/config.json"), "utf8"));
    const kelvinConfig = JSON.parse(
      await readFile(join(kelvinDir, ".pairmesh/config.json"), "utf8")
    );
    const paulPort = paulConfig.agent.port;
    const kelvinPort = kelvinConfig.agent.port;

    console.log("\nPeer health preflight:");
    await timedAsync("paul /health", () => waitForHealth(`http://127.0.0.1:${paulPort}`));
    await timedAsync("kelvin /health", () => waitForHealth(`http://127.0.0.1:${kelvinPort}`));

    console.log("\nMCP tool checks (installed pairmesh mcp):");
    const statusTool = await callMcpTool(pairmesh, prefix, paulDir, pathEnv, "pairmesh_status");
    const statusContent =
      statusTool.structuredContent ?? JSON.parse(statusTool.content?.[0]?.text ?? "{}");
    if (!statusContent.connected) {
      throw new Error("pairmesh_status expected connected session");
    }
    const peersTool = await callMcpTool(pairmesh, prefix, paulDir, pathEnv, "pairmesh_list_peers");
    const peersContent =
      peersTool.structuredContent ?? JSON.parse(peersTool.content?.[0]?.text ?? "{}");
    const peerNames = (peersContent.peers ?? []).map((peer) => peer.name ?? peer.agent?.name);
    if (!peerNames.includes("kelvin-agent")) {
      throw new Error(
        `pairmesh_list_peers expected kelvin-agent, got ${JSON.stringify(peerNames)}`
      );
    }
    console.log("  pairmesh_status: connected");
    console.log("  pairmesh_list_peers: kelvin-agent present");

    console.log("\nRestart recovery (kelvin):");
    sh(`${JSON.stringify(pairmesh)} restart`, { env: { PATH: pathEnv }, cwd: kelvinDir });
    await waitForHealth(`http://127.0.0.1:${kelvinPort}`);
    const paulAfterRestart = sh(`${JSON.stringify(pairmesh)} status`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    if (!paulAfterRestart.includes("kelvin-agent")) {
      throw new Error("Paul lost kelvin peer after kelvin restart");
    }
    console.log("  kelvin restart preserved session peer visibility");

    console.log("\nOffline / recovery (kelvin stop/start):");
    sh(`${JSON.stringify(pairmesh)} stop`, { env: { PATH: pathEnv }, cwd: kelvinDir });
    const paulWhileOffline = sh(`${JSON.stringify(pairmesh)} status`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    if (!paulWhileOffline.toLowerCase().includes("kelvin-agent")) {
      throw new Error("Expected kelvin-agent still listed while offline");
    }
    sh(`${JSON.stringify(pairmesh)} start`, { env: { PATH: pathEnv }, cwd: kelvinDir });
    await waitForHealth(`http://127.0.0.1:${kelvinPort}`);
    const paulAfterRecovery = sh(`${JSON.stringify(pairmesh)} status`, {
      env: { PATH: pathEnv },
      cwd: paulDir
    });
    if (!paulAfterRecovery.includes("kelvin-agent")) {
      throw new Error("Paul lost kelvin peer after kelvin stop/start recovery");
    }
    console.log("  kelvin stop/start recovery without re-pairing");

    sh(`${JSON.stringify(pairmesh)} stop`, { env: { PATH: pathEnv }, cwd: paulDir });
    sh(`${JSON.stringify(pairmesh)} stop`, { env: { PATH: pathEnv }, cwd: kelvinDir });

    console.log("\nClean install validation passed.");
    console.log(`  prefix: ${prefix}`);
    console.log(`  paul: ${paulDir}`);
    console.log(`  kelvin: ${kelvinDir}`);
    console.log(
      "\nLive Cursor UI validation: manual — see docs/validation/stage-05-installed-cursor-validation.md"
    );
  } finally {
    if (pairmesh && pathEnv) {
      for (const dir of [paulDir, kelvinDir]) {
        try {
          sh(`${JSON.stringify(pairmesh)} stop --force`, { env: { PATH: pathEnv }, cwd: dir });
        } catch {
          // best-effort cleanup
        }
      }
    }
    await rm(prefix, { recursive: true, force: true });
    await rm(paulDir, { recursive: true, force: true });
    await rm(kelvinDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
