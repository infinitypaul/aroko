#!/usr/bin/env node
/* eslint-env node */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const forbiddenPathPrefixes = [
  ".cursor/",
  "config/public-export/",
  "scripts/public-export/",
  "docs/validation/",
  "docs/operations/",
  "docs/ops/",
  "docs/stages/",
  "docs/stage21/",
  "docs/stage22/",
  "docs/stage23/",
  "docs/decisions/",
  "docs/remediations/",
  "docs/product/",
  "ops/",
  "apps/relay/deploy/",
  "scripts/stage21/",
  "scripts/stage23/"
];
const forbiddenExact = new Set([
  "docs/project-state.md",
  "docs/roadmap-and-ux-backlog.md",
  "docs/product-and-ux-architecture.md"
]);
const forbiddenContent = [
  { id: "users_infinitypaul", re: /\/Users\/InfinityPaul/ },
  { id: "grtsms_email", re: /grtsms@gmail\.com/ },
  { id: "grtms_email", re: /grtms@gmail\.com/ },
  { id: "opt_pairmesh_relay", re: /\/opt\/pairmesh-relay/ },
  { id: "sslip_hostname", re: /164-90-180-76\.sslip\.io/ },
  { id: "droplet_ip", re: /164\.90\.180\.76/ }
];

/** Product docs / README must not reintroduce internal process vocabulary. */
const productDocVocab = [
  { id: "stage_21", re: /\bStage\s*21\b/ },
  { id: "stage_22", re: /\bStage\s*22\b/ },
  { id: "stage_23", re: /\bStage\s*23\b/ },
  { id: "plane_b", re: /\bPlane\s*B\b/ },
  { id: "live_real", re: /\bLIVE_REAL\b/ },
  { id: "local_real", re: /\bLOCAL_REAL\b/ },
  { id: "ws_capacity_40", re: /≤\s*40\s*WebSocket/i },
  { id: "comfortable_30", re: /comfortable\s*≤\s*30/i },
  { id: "aroko_internal", re: /\baroko-internal\b/ },
  { id: "public_export_path", re: /\bconfig\/public-export\b/ },
  { id: "repowire", re: /\bRepoWire\b/ },
  { id: "fake_test_only", re: /\bFake\b.*\bTEST_ONLY\b/ }
];

function isProductDoc(file) {
  return file === "README.md" || file.startsWith("docs/");
}

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const errors = [];
for (const file of files) {
  if (forbiddenExact.has(file) || forbiddenPathPrefixes.some((p) => file === p.slice(0, -1) || file.startsWith(p))) {
    errors.push(`FORBIDDEN_PATH: ${file}`);
  }
}
for (const file of files) {
  if (file === "public-export.json") continue;
  if (/\.(png|jpg|jpeg|gif|webp|tgz|zip|pdf)$/i.test(file)) continue;
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  for (const rule of forbiddenContent) {
    if (rule.re.test(text)) errors.push(`FORBIDDEN_CONTENT[${rule.id}]: ${file}`);
  }
  if (isProductDoc(file)) {
    for (const rule of productDocVocab) {
      if (rule.re.test(text)) errors.push(`PRODUCT_VOCAB[${rule.id}]: ${file}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`public-boundary-check PASS (${files.length} tracked files)`);
