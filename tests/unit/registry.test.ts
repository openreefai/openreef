import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBareFormationName,
  parseRegistryRef,
  registryCacheDir,
  fetchRegistryIndex,
  lookupFormation,
  downloadFormationTarball,
  RegistryFetchError,
  RegistryFormationNotFoundError,
  RegistryVersionNotFoundError,
  RegistryDownloadError,
  RegistryIntegrityError,
  type RegistryIndex,
  type RegistryVersionEntry,
} from '../../src/core/registry.js';

// ── isBareFormationName ──

describe('isBareFormationName', () => {
  it('returns true for simple names', () => {
    expect(isBareFormationName('daily-ops')).toBe(true);
    expect(isBareFormationName('my-formation')).toBe(true);
    expect(isBareFormationName('Formation1')).toBe(true);
    expect(isBareFormationName('a')).toBe(true);
  });

  it('returns true for name@version', () => {
    expect(isBareFormationName('daily-ops@1.2.0')).toBe(true);
    expect(isBareFormationName('test@latest')).toBe(true);
  });

  it('returns false for relative paths', () => {
    expect(isBareFormationName('./daily-ops')).toBe(false);
    expect(isBareFormationName('../formations/daily-ops')).toBe(false);
  });

  it('returns false for absolute paths', () => {
    expect(isBareFormationName('/abs/path')).toBe(false);
  });

  it('returns false for home-relative paths', () => {
    expect(isBareFormationName('~/formations/daily-ops')).toBe(false);
  });

  it('returns false for tarballs', () => {
    expect(isBareFormationName('foo.tar.gz')).toBe(false);
    expect(isBareFormationName('foo.tgz')).toBe(false);
    expect(isBareFormationName('foo.reef.tar.gz')).toBe(false);
  });

  it('returns false for paths with slashes', () => {
    expect(isBareFormationName('path/to/formation')).toBe(false);
    expect(isBareFormationName('path\\to\\formation')).toBe(false);
  });

  it('returns false for names starting with non-alphanumeric', () => {
    expect(isBareFormationName('-bad')).toBe(false);
    expect(isBareFormationName('_bad')).toBe(false);
  });
});

// ── parseRegistryRef ──

describe('parseRegistryRef', () => {
  it('parses bare name', () => {
    expect(parseRegistryRef('daily-ops')).toEqual({
      name: 'daily-ops',
    });
  });

  it('parses name@version', () => {
    expect(parseRegistryRef('daily-ops@1.2.0')).toEqual({
      name: 'daily-ops',
      version: '1.2.0',
    });
  });

  it('parses name@latest', () => {
    expect(parseRegistryRef('daily-ops@latest')).toEqual({
      name: 'daily-ops',
      version: 'latest',
    });
  });

  it('handles name without version', () => {
    const result = parseRegistryRef('my-formation');
    expect(result.name).toBe('my-formation');
    expect(result.version).toBeUndefined();
  });
});

// ── registryCacheDir ──

describe('registryCacheDir', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-reg-test-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  it('produces different dirs for different registry URLs', () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const dir1 = registryCacheDir('https://example.com/index.json', env);
    const dir2 = registryCacheDir('https://other.com/index.json', env);
    expect(dir1).not.toBe(dir2);
  });

  it('produces same dir for same registry URL', () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const dir1 = registryCacheDir('https://example.com/index.json', env);
    const dir2 = registryCacheDir('https://example.com/index.json', env);
    expect(dir1).toBe(dir2);
  });

  it('uses URL hash as subdirectory', () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const dir = registryCacheDir('https://example.com/index.json', env);
    expect(dir).toContain('.reef');
    expect(dir).toContain('cache');
  });
});

// ── lookupFormation (Tide API) ──

describe('lookupFormation', () => {
  let originalFetch: typeof globalThis.fetch;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-reg-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves latest version when no version specified', async () => {
    globalThis.fetch = vi.fn()
      // First call: formation detail (to get latest_version)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            name: 'daily-ops',
            latest_version: '1.2.0',
            description: 'Daily operations',
          }),
      })
      // Second call: version detail (to get tarball_sha256)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            name: 'daily-ops',
            version: '1.2.0',
            tarball_sha256: 'abc789',
          }),
      }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const result = await lookupFormation('daily-ops', undefined, {
      registryUrl: 'https://tide.example.com',
      env,
    });

    expect(result.resolvedVersion).toBe('1.2.0');
    expect(result.entry.url).toContain('/api/formations/daily-ops/1.2.0/download');
    expect(result.entry.sha256).toBe('abc789');
  });

  it('resolves specific version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          name: 'daily-ops',
          version: '1.1.0',
          tarball_sha256: 'def456',
        }),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const result = await lookupFormation('daily-ops', '1.1.0', {
      registryUrl: 'https://tide.example.com',
      env,
    });

    expect(result.resolvedVersion).toBe('1.1.0');
    expect(result.entry.sha256).toBe('def456');
  });

  it('throws RegistryFormationNotFoundError for unknown formation', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          error: 'Formation not found',
        }),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    await expect(
      lookupFormation('unknown-formation', undefined, {
        registryUrl: 'https://tide.example.com',
        env,
      }),
    ).rejects.toThrow(RegistryFormationNotFoundError);
  });

  it('throws RegistryVersionNotFoundError for unknown version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          error: 'Version not found',
        }),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    await expect(
      lookupFormation('daily-ops', '9.9.9', {
        registryUrl: 'https://tide.example.com',
        env,
      }),
    ).rejects.toThrow(RegistryVersionNotFoundError);
  });

  it('resolves semver range via resolve endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          version: '1.2.3',
          tarball_sha256: 'abc123',
        }),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const result = await lookupFormation('daily-ops', '^1.0.0', {
      registryUrl: 'https://tide.example.com',
      env,
    });

    expect(result.resolvedVersion).toBe('1.2.3');
    expect(result.entry.sha256).toBe('abc123');

    // Verify it called the resolve endpoint
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain('/resolve?range=');
  });
});

// ── fetchRegistryIndex (legacy compat) ──

describe('fetchRegistryIndex', () => {
  let tempHome: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-reg-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  const validIndex: RegistryIndex = {
    version: 1,
    formations: {
      'daily-ops': {
        latest: '1.0.0',
        versions: {
          '1.0.0': { url: 'https://example.com/daily-ops-1.0.0.tar.gz' },
        },
      },
    },
  };

  it('fetches and caches registry index', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validIndex),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const result = await fetchRegistryIndex({
      registryUrl: 'https://example.com/index.json',
      env,
    });

    expect(result.version).toBe(1);
    expect(result.formations['daily-ops']).toBeDefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses cached index within TTL', async () => {
    // Pre-populate cache
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const cacheDir = registryCacheDir('https://example.com/index.json', env);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'registry-index.json'),
      JSON.stringify(validIndex),
    );

    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const result = await fetchRegistryIndex({
      registryUrl: 'https://example.com/index.json',
      env,
    });

    expect(result.version).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('bypasses cache when skipCache is true', async () => {
    // Pre-populate cache
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const cacheDir = registryCacheDir('https://example.com/index.json', env);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'registry-index.json'),
      JSON.stringify(validIndex),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validIndex),
    }) as unknown as typeof fetch;

    await fetchRegistryIndex({
      registryUrl: 'https://example.com/index.json',
      skipCache: true,
      env,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to stale cache on network error', async () => {
    // Pre-populate stale cache
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const cacheDir = registryCacheDir('https://example.com/index.json', env);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'registry-index.json'),
      JSON.stringify(validIndex),
    );

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const result = await fetchRegistryIndex({
      registryUrl: 'https://example.com/index.json',
      skipCache: true,
      env,
    });

    expect(result.version).toBe(1);
  });

  it('rejects corrupted cache and throws when offline', async () => {
    // Pre-populate corrupted cache
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const cacheDir = registryCacheDir('https://example.com/index.json', env);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'registry-index.json'),
      'not valid json{{{',
    );

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    await expect(
      fetchRegistryIndex({
        registryUrl: 'https://example.com/index.json',
        skipCache: true,
        env,
      }),
    ).rejects.toThrow(RegistryFetchError);

    // Corrupted cache should have been cleaned up
    expect(
      existsSync(join(cacheDir, 'registry-index.json')),
    ).toBe(false);
  });

  it('rejects invalid schema (version !== 1) and throws', async () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const cacheDir = registryCacheDir('https://example.com/index.json', env);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'registry-index.json'),
      JSON.stringify({ version: 2, formations: {} }),
    );

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    await expect(
      fetchRegistryIndex({
        registryUrl: 'https://example.com/index.json',
        skipCache: true,
        env,
      }),
    ).rejects.toThrow(RegistryFetchError);
  });

  it('throws when no cache and offline', async () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    await expect(
      fetchRegistryIndex({
        registryUrl: 'https://example.com/index.json',
        env,
      }),
    ).rejects.toThrow(RegistryFetchError);
  });
});

// ── downloadFormationTarball ──

describe('downloadFormationTarball', () => {
  let tempHome: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-reg-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  const tarballContent = Buffer.from('fake tarball content');
  const tarballSha256 = createHash('sha256')
    .update(tarballContent)
    .digest('hex');

  it('downloads and caches verified tarball', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(tarballContent.buffer.slice(
        tarballContent.byteOffset,
        tarballContent.byteOffset + tarballContent.byteLength,
      )),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const entry: RegistryVersionEntry = {
      url: 'https://example.com/daily-ops-1.0.0.tar.gz',
      sha256: tarballSha256,
    };

    const result = await downloadFormationTarball('daily-ops', '1.0.0', entry, {
      registryUrl: 'https://example.com',
      env,
    });

    expect(existsSync(result)).toBe(true);
    expect(result).toContain('tarballs');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses cached verified tarball', async () => {
    // First download to populate cache
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(tarballContent.buffer.slice(
        tarballContent.byteOffset,
        tarballContent.byteOffset + tarballContent.byteLength,
      )),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const entry: RegistryVersionEntry = {
      url: 'https://example.com/daily-ops-1.0.0.tar.gz',
      sha256: tarballSha256,
    };

    await downloadFormationTarball('daily-ops', '1.0.0', entry, {
      registryUrl: 'https://example.com',
      env,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second call should hit cache — no fetch
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const result = await downloadFormationTarball('daily-ops', '1.0.0', entry, {
      registryUrl: 'https://example.com',
      env,
    });

    expect(existsSync(result)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws RegistryIntegrityError on SHA-256 mismatch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(tarballContent.buffer.slice(
        tarballContent.byteOffset,
        tarballContent.byteOffset + tarballContent.byteLength,
      )),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const entry: RegistryVersionEntry = {
      url: 'https://example.com/daily-ops-1.0.0.tar.gz',
      sha256: 'wrong-hash-value',
    };

    await expect(
      downloadFormationTarball('daily-ops', '1.0.0', entry, {
        registryUrl: 'https://example.com',
        env,
      }),
    ).rejects.toThrow(RegistryIntegrityError);
  });

  it('warns and uses unverified/ when sha256 absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(tarballContent.buffer.slice(
        tarballContent.byteOffset,
        tarballContent.byteOffset + tarballContent.byteLength,
      )),
    }) as unknown as typeof fetch;

    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const entry: RegistryVersionEntry = {
      url: 'https://example.com/sketchy-0.1.0.tar.gz',
      // no sha256
    };

    const result = await downloadFormationTarball('sketchy', '0.1.0', entry, {
      registryUrl: 'https://example.com',
      env,
    });

    expect(result).toContain('unverified');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: No integrity hash'),
    );

    warnSpy.mockRestore();
  });

  it('always re-downloads unverified tarballs (never reuses cache)', async () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockFetchImpl = () => vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(tarballContent.buffer.slice(
        tarballContent.byteOffset,
        tarballContent.byteOffset + tarballContent.byteLength,
      )),
    }) as unknown as typeof fetch;

    const entry: RegistryVersionEntry = {
      url: 'https://example.com/sketchy-0.1.0.tar.gz',
      // no sha256
    };

    // First download populates unverified cache
    globalThis.fetch = mockFetchImpl();
    await downloadFormationTarball('sketchy', '0.1.0', entry, {
      registryUrl: 'https://example.com',
      env,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second download should still fetch (unverified = never reuse)
    globalThis.fetch = mockFetchImpl();
    await downloadFormationTarball('sketchy', '0.1.0', entry, {
      registryUrl: 'https://example.com',
      env,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('rejects non-http(s) URLs', async () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const entry: RegistryVersionEntry = {
      url: 'file:///etc/passwd',
      sha256: 'abc123',
    };

    await expect(
      downloadFormationTarball('evil', '1.0.0', entry, {
        registryUrl: 'https://example.com',
        env,
      }),
    ).rejects.toThrow(RegistryDownloadError);
  });
});
