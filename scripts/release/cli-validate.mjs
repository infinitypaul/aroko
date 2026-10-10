#!/usr/bin/env node
/* eslint-env node */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseIdentity } from "./validate-identity.mjs";
import { ProvenanceError } from "./git-identity.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const mode = process.argv.includes("--release") ? "release" : "development";

try {
  const result = validateReleaseIdentity(repoRoot, mode);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error instanceof ProvenanceError) {
    console.error(`PROVENANCE_${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
