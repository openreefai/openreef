export class UnsupportedSemverRange extends Error {
  constructor(range: string) {
    super(`Unsupported semver range: "${range}"`);
    this.name = 'UnsupportedSemverRange';
  }
}

export function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const cleaned = v.startsWith('v') ? v.slice(1) : v;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!match) {
    throw new Error(`Invalid semver version: "${v}"`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();

  // Wildcard — matches everything
  if (trimmed === '*') return true;

  // Exact match: 1.2.3
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return compareSemver(version, trimmed) === 0;
  }

  // Caret: ^1.2.3
  const caretMatch = /^\^(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (caretMatch) {
    const base = parseSemver(caretMatch[1]);
    const v = parseSemver(version);

    if (base.major > 0) {
      // ^1.2.3 := >=1.2.3, <2.0.0
      return v.major === base.major &&
        compareSemver(version, caretMatch[1]) >= 0;
    }
    if (base.minor > 0) {
      // ^0.2.3 := >=0.2.3, <0.3.0
      return v.major === 0 &&
        v.minor === base.minor &&
        compareSemver(version, caretMatch[1]) >= 0;
    }
    // ^0.0.3 := >=0.0.3, <0.0.4
    return v.major === 0 &&
      v.minor === 0 &&
      v.patch === base.patch;
  }

  // Tilde: ~1.2.3
  const tildeMatch = /^~(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (tildeMatch) {
    const base = parseSemver(tildeMatch[1]);
    const v = parseSemver(version);
    // ~1.2.3 := >=1.2.3, <1.3.0
    return v.major === base.major &&
      v.minor === base.minor &&
      compareSemver(version, tildeMatch[1]) >= 0;
  }

  // GTE: >=1.2.3
  const gteMatch = /^>=(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (gteMatch) {
    return compareSemver(version, gteMatch[1]) >= 0;
  }

  throw new UnsupportedSemverRange(range);
}

export function resolveRange(versions: string[], range: string): string | null {
  const matching = versions.filter((v) => satisfiesRange(v, range));
  if (matching.length === 0) return null;
  matching.sort(compareSemver);
  return matching[matching.length - 1];
}
