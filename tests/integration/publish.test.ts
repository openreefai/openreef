import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publish } from '../../src/commands/publish.js';
import { GitHubConflictError } from '../../src/core/github-api.js';

let tempHome: string;
let formationDir: string;
let fetchCallIndex: number;

const validManifest = {
  reef: '1.0',
  type: 'solo' as const,
  name: 'test-formation',
  version: '1.0.0',
  description: 'A test formation',
  namespace: 'testns',
  agents: {
    helper: {
      source: 'agents/helper',
      description: 'A helper agent',
    },
  },
};

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-publish-test-'));
  formationDir = join(tempHome, 'formation');
  fetchCallIndex = 0;

  await mkdir(formationDir, { recursive: true });
  await mkdir(join(formationDir, 'agents', 'helper'), { recursive: true });
  await writeFile(
    join(formationDir, 'agents', 'helper', 'SOUL.md'),
    'You are a helper agent.',
  );
  await writeFile(
    join(formationDir, 'reef.json'),
    JSON.stringify(validManifest, null, 2),
  );

  vi.stubGlobal('fetch', vi.fn());
  process.env.REEF_GITHUB_TOKEN = 'ghp_test_token_123';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.REEF_GITHUB_TOKEN;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

/**
 * Helper to create a sequenced fetch mock for the publish happy path.
 * The publish command makes several fetch calls in order:
 * 1. getRegistryIndex (GET /contents/index.json)
 * 2. createDraftRelease (POST /releases)
 * 3. uploadReleaseAsset (POST to uploads.github.com)
 * 4. updateRegistryIndex (PUT /contents/index.json)
 * 5. publishRelease (PATCH /releases/{id})
 */
function setupHappyPathFetch(existingIndex?: Record<string, unknown>): void {
  const indexContent = existingIndex ?? {
    version: 1,
    formations: {},
  };
  const base64Index = Buffer.from(JSON.stringify(indexContent)).toString('base64');

  const responses: Array<() => Response> = [
    // 1. getRegistryIndex
    () =>
      ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: base64Index,
            sha: 'existing-sha-123',
            encoding: 'base64',
          }),
      }) as unknown as Response,
    // 2. createDraftRelease
    () =>
      ({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            id: 99999,
            upload_url:
              'https://uploads.github.com/repos/openreefai/formations/releases/99999/assets{?name,label}',
          }),
      }) as unknown as Response,
    // 3. uploadReleaseAsset
    () =>
      ({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            browser_download_url:
              'https://github.com/openreefai/formations/releases/download/test-formation%401.0.0/test-formation-1.0.0.reef.tar.gz',
          }),
      }) as unknown as Response,
    // 4. updateRegistryIndex
    () =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: { sha: 'new-sha-456' } }),
      }) as unknown as Response,
    // 5. publishRelease
    () =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 99999, draft: false }),
      }) as unknown as Response,
  ];

  vi.mocked(fetch).mockImplementation(async () => {
    const idx = fetchCallIndex++;
    if (idx < responses.length) {
      return responses[idx]();
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response;
  });
}

describe('reef publish', () => {
  it('happy path: loads manifest, validates, creates draft release, uploads asset, updates index, publishes', async () => {
    setupHappyPathFetch();

    // Suppress console output
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await publish(formationDir, { yes: true });

    // Verify fetch was called at least 5 times (the full publish flow)
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(5);

    // Verify createDraftRelease was called with POST
    const createReleaseCall = vi.mocked(fetch).mock.calls[1];
    expect((createReleaseCall[1] as RequestInit).method).toBe('POST');

    // Verify updateRegistryIndex was called with PUT
    const updateIndexCall = vi.mocked(fetch).mock.calls[3];
    expect((updateIndexCall[1] as RequestInit).method).toBe('PUT');

    // Verify publishRelease was called with PATCH
    const publishCall = vi.mocked(fetch).mock.calls[4];
    expect((publishCall[1] as RequestInit).method).toBe('PATCH');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('version conflict: existing version in index returns error', async () => {
    const existingIndex = {
      version: 1,
      formations: {
        'test-formation': {
          latest: '1.0.0',
          versions: {
            '1.0.0': {
              url: 'https://example.com/test-1.0.0.tar.gz',
              sha256: 'abc123',
            },
          },
        },
      },
    };

    setupHappyPathFetch(existingIndex);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    try {
      await publish(formationDir, { yes: true });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    }

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    );

    errSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('no token: errors with missing token message', async () => {
    delete process.env.REEF_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    try {
      await publish(formationDir, { yes: true, token: undefined });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    }

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('No GitHub token'),
    );

    errSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('validates manifest before publishing', async () => {
    // Write invalid manifest (missing required fields)
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({ reef: '1.0', name: 'bad' }),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    try {
      await publish(formationDir, { yes: true });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    }

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('validation failed'),
    );

    errSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('latest update: non-prerelease updates latest; prerelease does not update latest', async () => {
    // Test non-prerelease: latest should be updated
    const existingFormations = {
      version: 1,
      formations: {
        'test-formation': {
          description: 'A test formation',
          latest: '0.9.0',
          versions: {
            '0.9.0': { url: 'https://example.com/test-0.9.0.tar.gz', sha256: 'old' },
          },
        },
      },
    };

    setupHappyPathFetch(existingFormations);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await publish(formationDir, { yes: true });

    // Verify the updateRegistryIndex call has updated latest
    const updateCall = vi.mocked(fetch).mock.calls[3];
    const updateBody = JSON.parse((updateCall[1] as RequestInit).body as string);
    const indexContent = JSON.parse(
      Buffer.from(updateBody.content, 'base64').toString('utf-8'),
    );
    expect(indexContent.formations['test-formation'].latest).toBe('1.0.0');

    logSpy.mockRestore();

    // Now test prerelease: latest should NOT be updated
    fetchCallIndex = 0;

    const preManifest = { ...validManifest, version: '2.0.0-beta.1' };
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify(preManifest, null, 2),
    );

    const existingWithLatest = {
      version: 1,
      formations: {
        'test-formation': {
          description: 'A test formation',
          latest: '1.0.0',
          versions: {
            '1.0.0': { url: 'https://example.com/test-1.0.0.tar.gz', sha256: 'abc' },
          },
        },
      },
    };

    setupHappyPathFetch(existingWithLatest);
    fetchCallIndex = 0;

    const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});

    await publish(formationDir, { yes: true });

    const updateCall2 = vi.mocked(fetch).mock.calls[3];
    const updateBody2 = JSON.parse((updateCall2[1] as RequestInit).body as string);
    const indexContent2 = JSON.parse(
      Buffer.from(updateBody2.content, 'base64').toString('utf-8'),
    );
    // Latest should still be 1.0.0 (not the prerelease)
    expect(indexContent2.formations['test-formation'].latest).toBe('1.0.0');

    logSpy2.mockRestore();
  });

  it('rollback: mock index update to fail (409), verify deleteRelease is called', async () => {
    let callIdx = 0;

    const base64Index = Buffer.from(
      JSON.stringify({ version: 1, formations: {} }),
    ).toString('base64');

    vi.mocked(fetch).mockImplementation(async () => {
      const idx = callIdx++;
      switch (idx) {
        case 0: // getRegistryIndex
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                content: base64Index,
                sha: 'sha-123',
                encoding: 'base64',
              }),
          } as unknown as Response;
        case 1: // createDraftRelease
          return {
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({
                id: 77777,
                upload_url:
                  'https://uploads.github.com/repos/openreefai/formations/releases/77777/assets{?name,label}',
              }),
          } as unknown as Response;
        case 2: // uploadReleaseAsset
          return {
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({
                browser_download_url: 'https://github.com/openreefai/formations/releases/download/tag/asset.tar.gz',
              }),
          } as unknown as Response;
        case 3: // updateRegistryIndex - FAIL with 409
          return {
            ok: false,
            status: 409,
            text: () => Promise.resolve('Conflict: SHA mismatch'),
          } as unknown as Response;
        case 4: // deleteRelease (rollback)
          return {
            ok: true,
            status: 204,
          } as unknown as Response;
        default:
          return { ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response;
      }
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(publish(formationDir, { yes: true })).rejects.toThrow(
      GitHubConflictError,
    );

    // Verify deleteRelease was called (call index 4)
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(5);
    const deleteCall = vi.mocked(fetch).mock.calls[4];
    expect((deleteCall[1] as RequestInit).method).toBe('DELETE');
    expect((deleteCall[0] as string)).toContain('/releases/77777');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
