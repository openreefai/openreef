import semver from 'semver';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(v: string): ParsedVersion {
  const cleaned = semver.clean(v);
  if (!cleaned) {
    throw new Error(`Invalid semver: "${v}"`);
  }
  const parsed = semver.parse(cleaned);
  if (!parsed) {
    throw new Error(`Invalid semver: "${v}"`);
  }
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
}

export function compareSemver(a: string, b: string): number {
  const result = semver.compare(a, b);
  return result;
}

export function satisfiesRange(version: string, range: string): boolean {
  const valid = semver.validRange(range);
  if (valid === null) {
    throw new Error(`Invalid semver range: "${range}"`);
  }
  return semver.satisfies(version, range);
}

export function resolveRange(versions: string[], range: string): string | null {
  return semver.maxSatisfying(versions, range);
}
