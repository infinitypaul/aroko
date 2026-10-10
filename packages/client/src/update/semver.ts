export type SemverCompareResult = -1 | 0 | 1;

export class SemverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemverError";
  }
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(input: string): ParsedSemver {
  const trimmed = input.trim();
  const match = SEMVER_RE.exec(trimmed);
  if (!match) {
    throw new SemverError(`Malformed version: ${input}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function compareIdentifier(a: string, b: string): SemverCompareResult {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const av = Number(a);
    const bv = Number(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** SemVer 2.0 precedence. Returns -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: string, b: string): SemverCompareResult {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const len = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const li = left.prerelease[i];
    const ri = right.prerelease[i];
    if (li === undefined) return -1;
    if (ri === undefined) return 1;
    const cmp = compareIdentifier(li, ri);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function isNewerSemver(candidate: string, installed: string): boolean {
  return compareSemver(candidate, installed) === 1;
}

export function isOlderSemver(candidate: string, installed: string): boolean {
  return compareSemver(candidate, installed) === -1;
}

export function isSameSemver(a: string, b: string): boolean {
  return compareSemver(a, b) === 0;
}
