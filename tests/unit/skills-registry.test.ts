import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchSkillsIndex,
  lookupSkill,
  resolveSkillsDependencies,
  verifyLockfileIntegrity,
  enforceLockfile,
  SkillNotFoundError,
  SkillVersionNotFoundError,
  LockfileViolationError,
  type SkillsRegistryIndex,
} from '../../src/core/skills-registry.js';
import type { Lockfile } from '../../src/types/lockfile.js';

// ── fetchSkillsIndex ──

describe('fetchSkillsIndex', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed index from mock fetch', async () => {
    const mockIndex: SkillsRegistryIndex = {
      skills: {
        'web-search': {
          latest: '1.0.0',
          versions: {
            '1.0.0': { url: 'https://example.com/web-search-1.0.0.tar.gz', sha256: 'abc123' },
          },
        },
      },
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIndex),
    } as unknown as Response);

    const result = await fetchSkillsIndex({
      registryUrl: 'https://example.com/skills/index.json',
    });

    expect(result.skills['web-search']).toBeDefined();
    expect(result.skills['web-search'].latest).toBe('1.0.0');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ── lookupSkill ──

describe('lookupSkill', () => {
  const index: SkillsRegistryIndex = {
    skills: {
      'web-search': {
        latest: '1.2.0',
        versions: {
          '1.0.0': { url: 'https://example.com/ws-1.0.0.tar.gz', sha256: 'aaa' },
          '1.1.0': { url: 'https://example.com/ws-1.1.0.tar.gz', sha256: 'bbb' },
          '1.2.0': { url: 'https://example.com/ws-1.2.0.tar.gz', sha256: 'ccc' },
        },
      },
    },
  };

  it('resolves exact version', () => {
    const result = lookupSkill(index, 'web-search', '1.1.0');
    expect(result.resolvedVersion).toBe('1.1.0');
    expect(result.entry.sha256).toBe('bbb');
  });

  it('resolves semver range via resolveRange', () => {
    const result = lookupSkill(index, 'web-search', '^1.0.0');
    expect(result.resolvedVersion).toBe('1.2.0');
    expect(result.entry.sha256).toBe('ccc');
  });

  it('throws SkillNotFoundError for unknown skill', () => {
    expect(() => lookupSkill(index, 'nonexistent')).toThrow(SkillNotFoundError);
  });

  it('throws SkillVersionNotFoundError for unmatched range', () => {
    expect(() => lookupSkill(index, 'web-search', '>=9.0.0')).toThrow(
      SkillVersionNotFoundError,
    );
  });
});

// ── resolveSkillsDependencies ──

describe('resolveSkillsDependencies', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-skills-test-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  it('returns lockfile with correct entries', async () => {
    const artifactContent = Buffer.from('fake-skill-tarball');
    const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');

    const mockIndex: SkillsRegistryIndex = {
      skills: {
        'web-search': {
          latest: '1.0.0',
          versions: {
            '1.0.0': {
              url: 'https://example.com/web-search-1.0.0.tar.gz',
              sha256: artifactSha256,
            },
          },
        },
      },
    };

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('index.json')) {
        return {
          ok: true,
          json: () => Promise.resolve(mockIndex),
        } as unknown as Response;
      }
      // Artifact download
      return {
        ok: true,
        arrayBuffer: () =>
          Promise.resolve(
            artifactContent.buffer.slice(
              artifactContent.byteOffset,
              artifactContent.byteOffset + artifactContent.byteLength,
            ),
          ),
      } as unknown as Response;
    });

    const lockfile = await resolveSkillsDependencies(
      { 'web-search': '^1.0.0' },
      {
        registryUrl: 'https://example.com/skills/index.json',
        env: { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv,
      },
    );

    expect(lockfile.skills['web-search']).toBeDefined();
    expect(lockfile.skills['web-search'].version).toBe('1.0.0');
    expect(lockfile.skills['web-search'].resolved).toBe(
      'https://example.com/web-search-1.0.0.tar.gz',
    );
    expect(lockfile.skills['web-search'].integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

// ── verifyLockfileIntegrity ──

describe('verifyLockfileIntegrity', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-skills-test-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  it('valid lockfile passes', async () => {
    const artifactContent = Buffer.from('skill-artifact-data');
    const integrity = `sha256-${createHash('sha256').update(artifactContent).digest('hex')}`;

    const lockfile: Lockfile = {
      skills: {
        'web-search': {
          version: '1.0.0',
          resolved: 'https://example.com/web-search-1.0.0.tar.gz',
          integrity,
        },
      },
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          artifactContent.buffer.slice(
            artifactContent.byteOffset,
            artifactContent.byteOffset + artifactContent.byteLength,
          ),
        ),
    } as unknown as Response);

    const result = await verifyLockfileIntegrity(lockfile, {
      env: { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('tampered lockfile fails (different integrity hash)', async () => {
    const artifactContent = Buffer.from('real-artifact-content');
    const wrongIntegrity = `sha256-${'a'.repeat(64)}`;

    const lockfile: Lockfile = {
      skills: {
        'web-search': {
          version: '1.0.0',
          resolved: 'https://example.com/web-search-1.0.0.tar.gz',
          integrity: wrongIntegrity,
        },
      },
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          artifactContent.buffer.slice(
            artifactContent.byteOffset,
            artifactContent.byteOffset + artifactContent.byteLength,
          ),
        ),
    } as unknown as Response);

    const result = await verifyLockfileIntegrity(lockfile, {
      env: { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Integrity mismatch');
  });
});

// ── enforceLockfile ──

describe('enforceLockfile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-enforce-test-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function writeLockfile(lockfileObj: Record<string, unknown>): Promise<void> {
    return writeFile(
      join(tempDir, 'reef.lock.json'),
      JSON.stringify(lockfileObj, null, 2),
    );
  }

  const validIntegrity = `sha256-${'ab'.repeat(32)}`;
  const validResolved = 'https://example.com/web-search-1.0.0.tar.gz';

  it('missing skill in lockfile throws LockfileViolationError', async () => {
    await writeLockfile({ skills: {} });

    await expect(
      enforceLockfile(tempDir, { 'web-search': '^1.0.0' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('locked version not satisfying range throws LockfileViolationError', async () => {
    await writeLockfile({
      skills: {
        'web-search': {
          version: '0.9.0',
          resolved: validResolved,
          integrity: validIntegrity,
        },
      },
    });

    await expect(
      enforceLockfile(tempDir, { 'web-search': '^1.0.0' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('malformed integrity (not sha256-hex) throws LockfileViolationError', async () => {
    await writeLockfile({
      skills: {
        'web-search': {
          version: '1.0.0',
          resolved: validResolved,
          integrity: 'md5-notahash',
        },
      },
    });

    await expect(
      enforceLockfile(tempDir, { 'web-search': '^1.0.0' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('malformed resolved URL (file://) throws LockfileViolationError', async () => {
    await writeLockfile({
      skills: {
        'web-search': {
          version: '1.0.0',
          resolved: 'file:///etc/passwd',
          integrity: validIntegrity,
        },
      },
    });

    await expect(
      enforceLockfile(tempDir, { 'web-search': '^1.0.0' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('unparseable version throws LockfileViolationError', async () => {
    await writeLockfile({
      skills: {
        'web-search': {
          version: 'not-a-version',
          resolved: validResolved,
          integrity: validIntegrity,
        },
      },
    });

    await expect(
      enforceLockfile(tempDir, { 'web-search': '*' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('extra skills in lockfile (not in manifest) produce warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const artifactContent = Buffer.from('artifact');
    const integrity = `sha256-${createHash('sha256').update(artifactContent).digest('hex')}`;

    await writeLockfile({
      skills: {
        'web-search': {
          version: '1.0.0',
          resolved: validResolved,
          integrity,
        },
        'extra-skill': {
          version: '2.0.0',
          resolved: 'https://example.com/extra-2.0.0.tar.gz',
          integrity,
        },
      },
    });

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          artifactContent.buffer.slice(
            artifactContent.byteOffset,
            artifactContent.byteOffset + artifactContent.byteLength,
          ),
        ),
    } as unknown as Response);

    // Only declare web-search, not extra-skill
    await enforceLockfile(
      tempDir,
      { 'web-search': '^1.0.0' },
      { env: { OPENCLAW_STATE_DIR: tempDir } as NodeJS.ProcessEnv },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extra-skill'),
    );

    warnSpy.mockRestore();
  });

  it('missing lockfile produces warning about `reef lock`', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Don't write a lockfile — let it be missing
    await enforceLockfile(tempDir, { 'web-search': '^1.0.0' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('reef lock'),
    );

    warnSpy.mockRestore();
  });
});
