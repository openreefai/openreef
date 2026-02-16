import { describe, it, expect } from 'vitest';
import {
  parseSemver,
  compareSemver,
  satisfiesRange,
  resolveRange,
  UnsupportedSemverRange,
} from '../../src/utils/semver.js';

describe('parseSemver', () => {
  it('parses a valid version', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('parses a version with v prefix', () => {
    expect(parseSemver('v1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('throws on invalid version', () => {
    expect(() => parseSemver('invalid')).toThrow('Invalid semver');
  });

  it('rejects version with prerelease suffix', () => {
    expect(() => parseSemver('1.2.3-beta')).toThrow('Invalid semver');
  });

  it('rejects version with trailing junk', () => {
    expect(() => parseSemver('1.2.3junk')).toThrow('Invalid semver');
  });

  it('rejects version with build metadata', () => {
    expect(() => parseSemver('1.2.3+build')).toThrow('Invalid semver');
  });
});

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns positive for greater major', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('returns negative for lesser minor', () => {
    expect(compareSemver('1.2.3', '1.3.0')).toBeLessThan(0);
  });

  it('compares patch', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });
});

describe('satisfiesRange', () => {
  describe('exact', () => {
    it('matches exact version', () => {
      expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    });

    it('rejects different version', () => {
      expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false);
    });
  });

  describe('caret', () => {
    it('^1.2.3 matches 1.3.0', () => {
      expect(satisfiesRange('1.3.0', '^1.2.3')).toBe(true);
    });

    it('^1.2.3 does not match 2.0.0', () => {
      expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false);
    });

    it('^1.2.3 does not match 1.2.2', () => {
      expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false);
    });

    it('^0.2.3 matches 0.2.5 (zero-major caret)', () => {
      expect(satisfiesRange('0.2.5', '^0.2.3')).toBe(true);
    });

    it('^0.2.3 does not match 0.3.0 (zero-major caret)', () => {
      expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    });

    it('^0.0.3 matches 0.0.3 only', () => {
      expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true);
      expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
    });
  });

  describe('tilde', () => {
    it('~1.2.3 matches 1.2.5', () => {
      expect(satisfiesRange('1.2.5', '~1.2.3')).toBe(true);
    });

    it('~1.2.3 does not match 1.3.0', () => {
      expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    });

    it('~1.2.3 does not match 1.2.2', () => {
      expect(satisfiesRange('1.2.2', '~1.2.3')).toBe(false);
    });
  });

  describe('gte', () => {
    it('>=1.2.3 matches 1.2.3', () => {
      expect(satisfiesRange('1.2.3', '>=1.2.3')).toBe(true);
    });

    it('>=1.2.3 matches 2.0.0', () => {
      expect(satisfiesRange('2.0.0', '>=1.2.3')).toBe(true);
    });

    it('>=1.2.3 does not match 1.2.2', () => {
      expect(satisfiesRange('1.2.2', '>=1.2.3')).toBe(false);
    });
  });

  describe('wildcard', () => {
    it('* matches any version', () => {
      expect(satisfiesRange('0.0.1', '*')).toBe(true);
      expect(satisfiesRange('99.99.99', '*')).toBe(true);
    });
  });

  describe('unsupported ranges', () => {
    it('throws for || ranges', () => {
      expect(() => satisfiesRange('1.0.0', '1.x || 2.x')).toThrow(UnsupportedSemverRange);
    });

    it('throws for compound ranges', () => {
      expect(() => satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toThrow(UnsupportedSemverRange);
    });

    it('throws for x-ranges', () => {
      expect(() => satisfiesRange('1.0.0', '1.x')).toThrow(UnsupportedSemverRange);
    });

    it('throws for hyphen ranges', () => {
      expect(() => satisfiesRange('1.5.0', '1.0.0 - 2.0.0')).toThrow(UnsupportedSemverRange);
    });
  });
});

describe('resolveRange', () => {
  const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0'];

  it('picks the highest matching version for caret', () => {
    expect(resolveRange(versions, '^1.0.0')).toBe('1.2.0');
  });

  it('picks the highest matching version for tilde', () => {
    expect(resolveRange(versions, '~1.0.0')).toBe('1.0.0');
  });

  it('returns null when no version matches', () => {
    expect(resolveRange(versions, '^3.0.0')).toBeNull();
  });

  it('picks exact match', () => {
    expect(resolveRange(versions, '2.0.0')).toBe('2.0.0');
  });

  it('wildcard returns highest', () => {
    expect(resolveRange(versions, '*')).toBe('2.1.0');
  });
});
