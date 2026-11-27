import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertOidcPublishWorkflow } from "./oidc-publish-workflow.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = join(repoRoot, ".github/workflows/release.yml");

describe("S23-8H OIDC publish workflow configuration", () => {
  it("rejects setup-node registry-url on the publish job (S23-8G failure mode)", () => {
    const broken = `
jobs:
  release-pack:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
  release-publish:
    if: \${{ github.event_name == 'workflow_dispatch' && inputs.confirm_publish == true && github.ref_type == 'tag' }}
    environment: production-release
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          registry-url: "https://registry.npmjs.org"
      - run: |
          if [ -n "\${NODE_AUTH_TOKEN:-}" ] || [ -n "\${NPM_TOKEN:-}" ]; then
            echo "FAIL: long-lived npm token env must not be present for trusted publishing"
            exit 1
          fi
          npm stage publish "$TGZ" --access public --tag alpha
`;
    expect(assertOidcPublishWorkflow(broken).reason).toBe("PUBLISH_SETUP_NODE_HAS_REGISTRY_URL");
  });

  it("rejects unconditional unset that would weaken the fail-closed guard", () => {
    const weakened = `
jobs:
  release-pack:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
  release-publish:
    if: \${{ github.event_name == 'workflow_dispatch' && inputs.confirm_publish == true && github.ref_type == 'tag' }}
    environment: production-release
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: |
          unset NODE_AUTH_TOKEN
          if [ -n "\${NODE_AUTH_TOKEN:-}" ] || [ -n "\${NPM_TOKEN:-}" ]; then
            echo "FAIL: long-lived npm token env must not be present for trusted publishing"
            exit 1
          fi
          npm stage publish "$TGZ" --access public --tag alpha
`;
    expect(assertOidcPublishWorkflow(weakened).reason).toBe("UNCONDITIONAL_UNSET_BEFORE_GUARD");
  });

  it("accepts the repository release.yml OIDC stage configuration", () => {
    const yaml = readFileSync(workflowPath, "utf8");
    const result = assertOidcPublishWorkflow(yaml);
    expect(result).toMatchObject({ ok: true });
    expect(yaml).toContain("id-token: write");
    expect(yaml).toContain("environment: production-release");
    expect(yaml).toContain('npm stage publish "$TGZ" --access public --tag alpha');
    // Publish Setup Node block must not set registry-url (comments may mention it).
    const publish = yaml.split("\n  release-publish:")[1] ?? "";
    const setupWith = publish.split("uses: actions/setup-node@v4")[1]?.split("- name:")[0] ?? "";
    expect(setupWith).toMatch(/with:/);
    expect(setupWith).not.toMatch(/^\s*registry-url\s*:/m);
  });
});
