#!/usr/bin/env node
/**
 * Detect which CLI binary name was used (aroko vs pairmesh).
 * Used for help branding only — same implementation either way.
 */
import { basename } from "node:path";

export type CliBrandName = "aroko" | "pairmesh";

export function detectCliInvocationName(
  argv1 = process.argv[1],
  argv0 = process.argv[0]
): CliBrandName {
  const candidates = [argv1, argv0]
    .filter(Boolean)
    .map((p) => basename(String(p).replaceAll("\\", "/")).toLowerCase());

  for (const name of candidates) {
    if (name === "aroko" || name.startsWith("aroko.") || name.includes("aroko")) {
      // Prefer exact binary names over path noise
      if (name === "aroko" || name === "aroko.js" || name.startsWith("aroko.")) {
        return "aroko";
      }
    }
    if (name === "pairmesh" || name === "pairmesh.js" || name.startsWith("pairmesh.")) {
      return "pairmesh";
    }
  }

  // Env override for tests / wrappers
  const forced = process.env.AROKO_CLI_NAME?.trim() || process.env.PAIRMESH_CLI_NAME?.trim();
  if (forced === "pairmesh") {
    return "pairmesh";
  }
  if (forced === "aroko") {
    return "aroko";
  }

  // Default canonical brand for help when invoked via node path / tsx
  return "aroko";
}

export function cliBinaryLabel(name: CliBrandName = detectCliInvocationName()): string {
  return name === "pairmesh" ? "pairmesh" : "aroko";
}

export function productDisplayName(): string {
  return "Aroko";
}
