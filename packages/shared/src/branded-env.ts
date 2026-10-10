
export type BrandedEnvConflictPolicy = "prefer-aroko" | "error";

export interface ReadBrandedEnvOptions {
  /** Canonical Aroko env name, e.g. AROKO_HOME */
  aroko: string;
  /** Legacy PairMesh env name, e.g. PAIRMESH_HOME */
  pairmesh: string;
  env?: NodeJS.ProcessEnv;
  defaultValue?: string;
  /** When both set and differ: prefer Aroko (default) or throw. */
  onConflict?: BrandedEnvConflictPolicy;
  /** Optional stderr warning when both set and differ (never logs values). */
  warnOnConflict?: boolean;
}

function raw(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) {
    return undefined;
  }
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve a branded configuration env var with AROKO_* → PAIRMESH_* → default precedence.
 */
export function readBrandedEnv(options: ReadBrandedEnvOptions): string | undefined {
  const env = options.env ?? process.env;
  const arokoVal = raw(env, options.aroko);
  const pairmeshVal = raw(env, options.pairmesh);
  const onConflict = options.onConflict ?? "prefer-aroko";

  if (arokoVal !== undefined && pairmeshVal !== undefined && arokoVal !== pairmeshVal) {
    if (onConflict === "error") {
      throw new Error(
        `Conflicting environment variables ${options.aroko} and ${options.pairmesh} are both set to different values. Unset one of them.`
      );
    }
    if (options.warnOnConflict) {
      console.warn(
        `Warning: both ${options.aroko} and ${options.pairmesh} are set to different values; using ${options.aroko}.`
      );
    }
    return arokoVal;
  }

  if (arokoVal !== undefined) {
    return arokoVal;
  }
  if (pairmeshVal !== undefined) {
    return pairmeshVal;
  }
  return options.defaultValue;
}

export function readBrandedEnvRequired(
  options: Omit<ReadBrandedEnvOptions, "defaultValue"> & { defaultValue: string }
): string {
  return readBrandedEnv(options) ?? options.defaultValue;
}

/** Canonical MCP server keys (Cursor mcpServers / Claude servers). */
export const MCP_SERVER_KEY_CANONICAL = "aroko";
export const MCP_SERVER_KEY_LEGACY = "pairmesh";

/**
 * Prefer canonical `aroko` entry; fall back to legacy `pairmesh`.
 * If both exist, prefer `aroko` (caller may still detect dual presence).
 */
export function pickMcpServerEntry<T>(
  servers: Record<string, T> | undefined
): { key: typeof MCP_SERVER_KEY_CANONICAL | typeof MCP_SERVER_KEY_LEGACY; entry: T } | null {
  if (!servers) {
    return null;
  }
  if (servers[MCP_SERVER_KEY_CANONICAL] !== undefined) {
    return { key: MCP_SERVER_KEY_CANONICAL, entry: servers[MCP_SERVER_KEY_CANONICAL] };
  }
  if (servers[MCP_SERVER_KEY_LEGACY] !== undefined) {
    return { key: MCP_SERVER_KEY_LEGACY, entry: servers[MCP_SERVER_KEY_LEGACY] };
  }
  return null;
}

export function mcpServerKeysPresent(servers: Record<string, unknown> | undefined): {
  aroko: boolean;
  pairmesh: boolean;
  both: boolean;
} {
  const aroko = Boolean(servers?.[MCP_SERVER_KEY_CANONICAL]);
  const pairmesh = Boolean(servers?.[MCP_SERVER_KEY_LEGACY]);
  return { aroko, pairmesh, both: aroko && pairmesh };
}
