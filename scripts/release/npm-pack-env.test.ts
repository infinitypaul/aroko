import { describe, expect, it } from "vitest";
import {
  assertPackagingEnvIsNonpublishing,
  buildPackagingNpmEnv
} from "./npm-pack-env.mjs";

describe("S23-7U packaging npm env sanitization", () => {
  it("strips setup-node userconfig, auth tokens, and pnpm npm_config_* keys", () => {
    const sanitized = buildPackagingNpmEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      NODE_AUTH_TOKEN: "should-not-leak",
      NPM_TOKEN: "should-not-leak",
      NPM_CONFIG_USERCONFIG: "/home/runner/work/_temp/.npmrc",
      npm_config_verify_deps_before_run: "false",
      npm_config_always_auth: "true",
      npm_config__jsr_registry: "https://npm.jsr.io",
      npm_config_user_agent: "pnpm/10.15.1 npm/? node/v22.23.2 linux x64",
      SOME_UNRELATED: "keep-me"
    });

    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/runner");
    expect(sanitized.SOME_UNRELATED).toBe("keep-me");
    expect(sanitized.NODE_AUTH_TOKEN).toBeUndefined();
    expect(sanitized.NPM_TOKEN).toBeUndefined();
    expect(sanitized.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(sanitized.npm_config_verify_deps_before_run).toBeUndefined();
    expect(sanitized.npm_config_always_auth).toBeUndefined();
    expect(sanitized.npm_config__jsr_registry).toBeUndefined();
    expect(sanitized.npm_config_user_agent).toBeUndefined();
    expect(sanitized.npm_config_registry).toBe("https://registry.npmjs.org/");
  });

  it("assertPackagingEnvIsNonpublishing rejects auth and unexpected registry", () => {
    expect(assertPackagingEnvIsNonpublishing(buildPackagingNpmEnv({})).ok).toBe(true);
    expect(
      assertPackagingEnvIsNonpublishing({ NODE_AUTH_TOKEN: "x" } as NodeJS.ProcessEnv).reason
    ).toBe("AUTH_TOKEN_PRESENT");
    expect(
      assertPackagingEnvIsNonpublishing({
        NPM_CONFIG_USERCONFIG: "/tmp/.npmrc"
      } as NodeJS.ProcessEnv).reason
    ).toBe("USERCONFIG_PRESENT");
    expect(
      assertPackagingEnvIsNonpublishing({
        npm_config_registry: "https://example.invalid/"
      } as NodeJS.ProcessEnv).reason
    ).toBe("UNEXPECTED_REGISTRY");
  });
});
