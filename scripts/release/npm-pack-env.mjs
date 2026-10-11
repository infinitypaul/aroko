
/**
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildPackagingNpmEnv(baseEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...baseEnv };

  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /^NPM_CONFIG_/i.test(key)) {
      delete env[key];
    }
  }

  // Never carry publish/stage credentials into pack/install-for-bundle steps.
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;

  // Explicit public registry only — no auth token, no always-auth userconfig.
  env.npm_config_registry = "https://registry.npmjs.org/";

  return env;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertPackagingEnvIsNonpublishing(env = process.env) {
  if (env.NODE_AUTH_TOKEN || env.NPM_TOKEN) {
    return { ok: false, reason: "AUTH_TOKEN_PRESENT" };
  }
  if (env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig) {
    return { ok: false, reason: "USERCONFIG_PRESENT" };
  }
  const registry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (registry && registry !== "https://registry.npmjs.org/") {
    return { ok: false, reason: "UNEXPECTED_REGISTRY" };
  }
  return { ok: true };
}
