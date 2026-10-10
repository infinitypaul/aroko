/**
 * S23-7Q — Annotated release-tag verification regression tests.
 */
import { describe, expect, it } from "vitest";
import { verifyAnnotatedReleaseTag } from "./verify-annotated-release-tag.mjs";

type GitMap = Record<string, string | (() => string)>;

function mockRunGit(map: GitMap) {
  return (args: string[]) => {
    const key = args.join(" ");
    if (!(key in map)) {
      throw new Error(`unexpected git ${key}`);
    }
    const value = map[key];
    return typeof value === "function" ? value() : value;
  };
}

const base = {
  repoRoot: process.cwd(),
  repository: "infinitypaul/aroko",
  repositoryId: "1413375921",
  githubRef: "refs/tags/v0.1.0-alpha.1",
  githubRefType: "tag",
  githubRefName: "v0.1.0-alpha.1",
  fetchAnnotatedTag: false
};

describe("S23-7Q verifyAnnotatedReleaseTag", () => {
  it("accepts a valid annotated tag peeling to HEAD", () => {
    const runGit = mockRunGit({
      "rev-parse refs/tags/v0.1.0-alpha.1": "b83f06e164748b163ca46e724560024cc4da51c7",
      "cat-file -t b83f06e164748b163ca46e724560024cc4da51c7": "tag",
      "rev-parse refs/tags/v0.1.0-alpha.1^{}": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "rev-parse HEAD": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "status --porcelain": ""
    });
    const result = verifyAnnotatedReleaseTag({ ...base, runGit });
    expect(result.tagObject).toBe("b83f06e164748b163ca46e724560024cc4da51c7");
    expect(result.peeledCommit).toBe("60124cec4480e12f4f54d996aa8cb5e30b29b1b6");
  });

  it("rejects a lightweight tag (object type commit)", () => {
    const runGit = mockRunGit({
      "rev-parse refs/tags/v0.1.0-alpha.1": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "cat-file -t 60124cec4480e12f4f54d996aa8cb5e30b29b1b6": "commit",
      "rev-parse refs/tags/v0.1.0-alpha.1^{}": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "rev-parse HEAD": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "status --porcelain": ""
    });
    expect(() => verifyAnnotatedReleaseTag({ ...base, runGit })).toThrow(
      /annotated tag object/
    );
  });

  it("rejects a missing tag object", () => {
    const runGit = (args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse refs/tags/v0.1.0-alpha.1") {
        return "b83f06e164748b163ca46e724560024cc4da51c7";
      }
      if (key.startsWith("cat-file -t ")) {
        throw new Error("not found");
      }
      throw new Error(`unexpected git ${key}`);
    };
    expect(() => verifyAnnotatedReleaseTag({ ...base, runGit })).toThrow(/not present/);
  });

  it("rejects incorrect peeled commit vs HEAD", () => {
    const runGit = mockRunGit({
      "rev-parse refs/tags/v0.1.0-alpha.1": "b83f06e164748b163ca46e724560024cc4da51c7",
      "cat-file -t b83f06e164748b163ca46e724560024cc4da51c7": "tag",
      "rev-parse refs/tags/v0.1.0-alpha.1^{}": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "rev-parse HEAD": "28906c2ad197de1bbd077f51a45d3d8506b099a0",
      "status --porcelain": ""
    });
    expect(() => verifyAnnotatedReleaseTag({ ...base, runGit })).toThrow(/peels to/);
  });

  it("rejects wrong repository identity", () => {
    expect(() =>
      verifyAnnotatedReleaseTag({
        ...base,
        repository: "infinitypaul/aroko-internal",
        runGit: mockRunGit({})
      })
    ).toThrow(/must run on infinitypaul\/aroko/);
  });

  it("rejects wrong repository id", () => {
    expect(() =>
      verifyAnnotatedReleaseTag({
        ...base,
        repositoryId: "1",
        runGit: mockRunGit({})
      })
    ).toThrow(/unexpected repository id/);
  });

  it("rejects wrong ref type", () => {
    expect(() =>
      verifyAnnotatedReleaseTag({
        ...base,
        githubRefType: "branch",
        githubRef: "refs/heads/main",
        runGit: mockRunGit({})
      })
    ).toThrow(/requires a tag ref/);
  });

  it("rejects wrong alpha tag name", () => {
    expect(() =>
      verifyAnnotatedReleaseTag({
        ...base,
        githubRef: "refs/tags/v0.1.0",
        githubRefName: "v0.1.0",
        runGit: mockRunGit({})
      })
    ).toThrow(/vX\.Y\.Z-alpha\.N/);
  });

  it("rejects dirty checkout", () => {
    const runGit = mockRunGit({
      "rev-parse refs/tags/v0.1.0-alpha.1": "b83f06e164748b163ca46e724560024cc4da51c7",
      "cat-file -t b83f06e164748b163ca46e724560024cc4da51c7": "tag",
      "rev-parse refs/tags/v0.1.0-alpha.1^{}": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "rev-parse HEAD": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "status --porcelain": " M package.json"
    });
    expect(() => verifyAnnotatedReleaseTag({ ...base, runGit })).toThrow(/working tree/);
  });

  it("rejects tag object mismatch after checkout overwrite (commit sha as ref)", () => {
    // This is the actions/checkout failure mode observed in run 38090191466.
    const runGit = mockRunGit({
      "rev-parse refs/tags/v0.1.0-alpha.1": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
      "cat-file -t 60124cec4480e12f4f54d996aa8cb5e30b29b1b6": "commit"
    });
    expect(() => verifyAnnotatedReleaseTag({ ...base, runGit })).toThrow(
      /annotated tag object/
    );
  });

  it("fetches annotated tag from origin when requested", () => {
    const calls: string[] = [];
    const runGit = (args: string[]) => {
      calls.push(args.join(" "));
      const map: GitMap = {
        "fetch origin refs/tags/v0.1.0-alpha.1:refs/tags/v0.1.0-alpha.1 --force": "",
        "rev-parse refs/tags/v0.1.0-alpha.1": "b83f06e164748b163ca46e724560024cc4da51c7",
        "cat-file -t b83f06e164748b163ca46e724560024cc4da51c7": "tag",
        "rev-parse refs/tags/v0.1.0-alpha.1^{}": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
        "rev-parse HEAD": "60124cec4480e12f4f54d996aa8cb5e30b29b1b6",
        "status --porcelain": ""
      };
      const key = args.join(" ");
      if (!(key in map)) throw new Error(`unexpected git ${key}`);
      return map[key] as string;
    };
    verifyAnnotatedReleaseTag({ ...base, fetchAnnotatedTag: true, runGit });
    expect(calls[0]).toContain("fetch origin refs/tags/v0.1.0-alpha.1");
  });
});
