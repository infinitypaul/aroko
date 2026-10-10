export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export function isoNow(): string {
  return new Date().toISOString();
}

export {
  readBrandedEnv,
  readBrandedEnvRequired,
  pickMcpServerEntry,
  mcpServerKeysPresent,
  MCP_SERVER_KEY_CANONICAL,
  MCP_SERVER_KEY_LEGACY,
  type BrandedEnvConflictPolicy,
  type ReadBrandedEnvOptions
} from "./branded-env.js";
