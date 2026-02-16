import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lock } from '../../src/commands/lock.js';
import {
  enforceLockfile,
  SkillNotFoundError,
  LockfileViolationError,
} from '../../src/core/skills-registry.js';
import type { SkillsRegistryIndex } from '../../src/core/skills-registry.js';

let tempHome: string;
let formationDir: string;

const artifactContent = Buffer.from('fake-skill-tarball-content');
const artifactSha256 = createHash('sha256').update(artifactContent).digest('hex');

function makeManifest(skills?: Record<string, string>): string {
  const manifest: Record<string, unknown> = {
    reef: '1.0',
    type: 'solo',
    name: 'test-formation',
    version: '1.0.0',
    description: 'Test formation for lock tests',
    namespace: 'testns',
    agents: {
      helper: {
        source: 'agents/helper',
        description: 'A helper agent',
      },
    },
  };

  if (skills && Object.keys(skills).length > 0) {
    manifest.dependencies = { skills };
  }

  return JSON.stringify(manifest, null, 2);
}

function makeMockIndex(
  skillVersions: Record<string, { latest: string; versions: Record<string, { url: string; sha256: string }> }>,
): SkillsRegistryIndex {
  return { skills: skillVersions };
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-lock-test-'));
  formationDir = join(tempHome, 'formation');
  await mkdir(formationDir, { recursive: true });
  await mkdir(join(formationDir, 'agents', 'helper'), { recursive: true });
  await writeFile(join(formationDir, 'agents', 'helper', 'SOUL.md'), 'You are a helper.');

  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef lock', () => {
  it('locks skills and writes valid lockfile with correct entries', async () => {
    const mockIndex = makeMockIndex({
      'web-search': {
        latest: '1.0.0',
        versions: {
          '1.0.0': {
            url: 'https://example.com/web-search-1.0.0.tar.gz',
            sha256: artifactSha256,
          },
        },
      },
    });

    await writeFile(
      join(formationDir, 'reef.json'),
      makeManifest({ 'web-search': '^1.0.0' }),
    );

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('index.json')) {
        return {
          ok: true,
          json: () => Promise.resolve(mockIndex),
        } as unknown as Response;
      }
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

    await lock(formationDir, {
      registryUrl: 'https://example.com/skills/index.json',
    });

    const lockfileRaw = await readFile(join(formationDir, 'reef.lock.json'), 'utf-8');
    const lockfile = JSON.parse(lockfileRaw);

    expect(lockfile.skills['web-search']).toBeDefined();
    expect(lockfile.skills['web-search'].version).toBe('1.0.0');
    expect(lockfile.skills['web-search'].resolved).toBe(
      'https://example.com/web-search-1.0.0.tar.gz',
    );
    expect(lockfile.skills['web-search'].integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('handles no skills (prints "No skill dependencies to lock.")', async () => {
    await writeFile(join(formationDir, 'reef.json'), makeManifest());

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await lock(formationDir);

    expect(logSpy).toHaveBeenCalledWith('No skill dependencies to lock.');

    logSpy.mockRestore();
  });

  it('handles unknown skill (SkillNotFoundError from registry mock)', async () => {
    const mockIndex = makeMockIndex({});

    await writeFile(
      join(formationDir, 'reef.json'),
      makeManifest({ 'nonexistent-skill': '^1.0.0' }),
    );

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIndex),
    } as unknown as Response);

    await expect(
      lock(formationDir, {
        registryUrl: 'https://example.com/skills/index.json',
      }),
    ).rejects.toThrow(SkillNotFoundError);
  });

  it('preserves _comment in existing lockfile', async () => {
    const mockIndex = makeMockIndex({
      'web-search': {
        latest: '1.0.0',
        versions: {
          '1.0.0': {
            url: 'https://example.com/web-search-1.0.0.tar.gz',
            sha256: artifactSha256,
          },
        },
      },
    });

    await writeFile(
      join(formationDir, 'reef.json'),
      makeManifest({ 'web-search': '^1.0.0' }),
    );

    // Write existing lockfile with a _comment
    await writeFile(
      join(formationDir, 'reef.lock.json'),
      JSON.stringify({
        _comment: 'This file is auto-generated by reef lock. Do not edit.',
        skills: {},
      }),
    );

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('index.json')) {
        return {
          ok: true,
          json: () => Promise.resolve(mockIndex),
        } as unknown as Response;
      }
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

    await lock(formationDir, {
      registryUrl: 'https://example.com/skills/index.json',
    });

    const lockfileRaw = await readFile(join(formationDir, 'reef.lock.json'), 'utf-8');
    const lockfile = JSON.parse(lockfileRaw);

    expect(lockfile._comment).toBe('This file is auto-generated by reef lock. Do not edit.');
    expect(lockfile.skills['web-search']).toBeDefined();
  });
});

describe('enforceLockfile in install context', () => {
  it('error on missing skill in lockfile', async () => {
    await writeFile(
      join(formationDir, 'reef.lock.json'),
      JSON.stringify({ skills: {} }),
    );

    await expect(
      enforceLockfile(formationDir, { 'web-search': '^1.0.0' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('error on range mismatch', async () => {
    const integrity = `sha256-${'ab'.repeat(32)}`;

    await writeFile(
      join(formationDir, 'reef.lock.json'),
      JSON.stringify({
        skills: {
          'web-search': {
            version: '0.5.0',
            resolved: 'https://example.com/web-search-0.5.0.tar.gz',
            integrity,
          },
        },
      }),
    );

    await expect(
      enforceLockfile(formationDir, { 'web-search': '^1.0.0' }),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('error on integrity failure (mock fetch returns different content)', async () => {
    const lockedContent = Buffer.from('original-artifact');
    const lockedIntegrity = `sha256-${createHash('sha256').update(lockedContent).digest('hex')}`;

    const tamperedContent = Buffer.from('tampered-artifact');

    await writeFile(
      join(formationDir, 'reef.lock.json'),
      JSON.stringify({
        skills: {
          'web-search': {
            version: '1.0.0',
            resolved: 'https://example.com/web-search-1.0.0.tar.gz',
            integrity: lockedIntegrity,
          },
        },
      }),
    );

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          tamperedContent.buffer.slice(
            tamperedContent.byteOffset,
            tamperedContent.byteOffset + tamperedContent.byteLength,
          ),
        ),
    } as unknown as Response);

    await expect(
      enforceLockfile(
        formationDir,
        { 'web-search': '^1.0.0' },
        { env: { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv },
      ),
    ).rejects.toThrow(LockfileViolationError);
  });

  it('warning on extra lockfile entries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const content = Buffer.from('artifact-data');
    const integrity = `sha256-${createHash('sha256').update(content).digest('hex')}`;

    await writeFile(
      join(formationDir, 'reef.lock.json'),
      JSON.stringify({
        skills: {
          'web-search': {
            version: '1.0.0',
            resolved: 'https://example.com/web-search-1.0.0.tar.gz',
            integrity,
          },
          'unused-skill': {
            version: '2.0.0',
            resolved: 'https://example.com/unused-2.0.0.tar.gz',
            integrity,
          },
        },
      }),
    );

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
          ),
        ),
    } as unknown as Response);

    await enforceLockfile(
      formationDir,
      { 'web-search': '^1.0.0' },
      { env: { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unused-skill'),
    );

    warnSpy.mockRestore();
  });
});
