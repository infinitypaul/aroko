#!/usr/bin/env node
/* eslint-env node */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function workspaceFromArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--workspace" && args[i + 1]) {
      return args[i + 1];
    }
    if (token?.startsWith("--workspace=")) {
      return token.slice("--workspace=".length);
    }
  }
  return undefined;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const explicitWorkspace = workspaceFromArgs(args);
const projectRoot = explicitWorkspace
  ? resolve(explicitWorkspace)
  : process.env.AROKO_PROJECT_ROOT?.trim() ||
    process.env.PAIRMESH_PROJECT_ROOT?.trim() ||
    process.env.INIT_CWD?.trim() ||
    process.env.PWD?.trim() ||
    process.cwd();

const result = spawnSync("pnpm", ["--filter", "@pairmesh/cli", "run", "dev", "--", ...args], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AROKO_PROJECT_ROOT: projectRoot,
    PAIRMESH_PROJECT_ROOT: projectRoot,
    AROKO_LAUNCH_MODE: "development",
    PAIRMESH_LAUNCH_MODE: "development"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
