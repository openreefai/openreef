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
  return semver.compare(a, b);
}

export function satisfiesRange(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}

export function resolveRange(versions: string[], range: string): string | null {
  return semver.maxSatisfying(versions, range);
}
