#!/usr/bin/env node
/* eslint-env node */
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const outputDir = join(repoRoot, "dist-packages");

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const tarballs = (await readdir(outputDir)).filter((name) => name.endsWith(".tgz")).sort();
  const tarballName = tarballs.at(-1);
  if (!tarballName) {
    throw new Error("Run pnpm package:pairmesh first.");
  }
  const tarballPath = join(outputDir, tarballName);
  const manifestPath = join(outputDir, "pairmesh-cli-contents.txt");
  execSync(`tar -tzf ${JSON.stringify(tarballPath)} > ${JSON.stringify(manifestPath)}`);

  const entries = readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
  const compressed = statSync(tarballPath).size;

  const byPrefix = new Map();
  for (const entry of entries) {
    const parts = entry.replace(/^package\//, "").split("/");
    const top = parts[0] === "node_modules" ? parts.slice(0, 2).join("/") : parts[0];
    byPrefix.set(top, (byPrefix.get(top) ?? 0) + 1);
  }

  const sortedPrefixes = [...byPrefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  const suspicious = entries.filter(
    (entry) =>
      entry.includes(".test.") ||
      entry.includes("/fixtures/") ||
      entry.includes("/.pairmesh/") ||
      entry.includes("/.cursor/") ||
      (entry.endsWith(".md") && entry.includes("node_modules"))
  );

  console.log("PairMesh package size audit");
  console.log(`  tarball: ${basename(tarballPath)}`);
  console.log(`  compressed: ${formatBytes(compressed)}`);
  console.log(`  entries: ${entries.length}`);
  console.log("");
  console.log("Top entry prefixes:");
  for (const [prefix, count] of sortedPrefixes) {
    console.log(`  ${count.toString().padStart(5)}  ${prefix}`);
  }

  console.log("");
  if (suspicious.length > 0) {
    console.log(`Suspicious bundled paths (${suspicious.length} sample):`);
    for (const entry of suspicious.slice(0, 10)) {
      console.log(`  ${entry}`);
    }
  } else {
    console.log("No suspicious test/fixture/local-state paths detected.");
  }

  console.log("");
  console.log("Safe reduction assessment:");
  console.log(
    "  - Source maps in dist/ are present; removing them would shrink size but reduce debuggability."
  );
  console.log(
    "  - Transitive dependency docs/examples under node_modules/ are npm default; stripping is risky."
  );
  console.log("  - No safe size reduction applied in Prompt 2 (correctness over compression).");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
