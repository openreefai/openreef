import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRegistryIndex,
  createDraftRelease,
  uploadReleaseAsset,
  publishRelease,
  deleteRelease,
  updateRegistryIndex,
  GitHubAuthError,
  GitHubConflictError,
  PublishRollbackError,
} from '../../src/core/github-api.js';
import type { RegistryIndex } from '../../src/core/registry.js';

const apiOptions = { token: 'ghp_testtoken123', owner: 'test-org', repo: 'test-repo' };

describe('getRegistryIndex', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses base64 content from GitHub API response', async () => {
    const indexContent: RegistryIndex = {
      version: 1,
      formations: {
        'daily-ops': {
          latest: '1.0.0',
          versions: { '1.0.0': { url: 'https://example.com/daily-ops-1.0.0.tar.gz' } },
        },
      },
    };

    const base64Content = Buffer.from(JSON.stringify(indexContent)).toString('base64');

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          content: base64Content,
          sha: 'abc123sha',
          encoding: 'base64',
        }),
    } as unknown as Response);

    const result = await getRegistryIndex(apiOptions);

    expect(result).not.toBeNull();
    expect(result!.content.version).toBe(1);
    expect(result!.content.formations['daily-ops'].latest).toBe('1.0.0');
    expect(result!.sha).toBe('abc123sha');
  });

  it('returns null for 404', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as unknown as Response);

    const result = await getRegistryIndex(apiOptions);
    expect(result).toBeNull();
  });
});

describe('createDraftRelease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST with draft:true, returns releaseId and uploadUrl', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          id: 12345,
          upload_url: 'https://uploads.github.com/repos/test-org/test-repo/releases/12345/assets{?name,label}',
        }),
    } as unknown as Response);

    const result = await createDraftRelease(
      'my-formation@1.0.0',
      'my-formation v1.0.0',
      'A test release',
      apiOptions,
    );

    expect(result.releaseId).toBe(12345);
    expect(result.uploadUrl).toBe(
      'https://uploads.github.com/repos/test-org/test-repo/releases/12345/assets',
    );

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;
    expect(url).toContain('/releases');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.draft).toBe(true);
    expect(body.tag_name).toBe('my-formation@1.0.0');
  });
});

describe('uploadReleaseAsset', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-gh-test-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('uploads tarball buffer, returns assetUrl', async () => {
    const tarballPath = join(tempDir, 'test-formation-1.0.0.tar.gz');
    await writeFile(tarballPath, Buffer.from('fake tarball content'));

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          browser_download_url: 'https://github.com/test-org/test-repo/releases/download/v1.0.0/test-formation-1.0.0.tar.gz',
        }),
    } as unknown as Response);

    const result = await uploadReleaseAsset(12345, tarballPath, apiOptions);

    expect(result.assetUrl).toContain('test-formation-1.0.0.tar.gz');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const opts = fetchCall[1] as RequestInit;
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/gzip');
  });
});

describe('publishRelease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends PATCH with draft:false', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 12345, draft: false }),
    } as unknown as Response);

    await publishRelease(12345, apiOptions);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;
    expect(url).toContain('/releases/12345');
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body as string);
    expect(body.draft).toBe(false);
  });
});

describe('deleteRelease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends DELETE', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 204,
    } as unknown as Response);

    await deleteRelease(12345, apiOptions);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;
    expect(url).toContain('/releases/12345');
    expect(opts.method).toBe('DELETE');
  });
});

describe('updateRegistryIndex', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends PUT with base64 content and SHA', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: { sha: 'newsha' } }),
    } as unknown as Response);

    const index: RegistryIndex = {
      version: 1,
      formations: {
        'test-formation': {
          latest: '1.0.0',
          versions: { '1.0.0': { url: 'https://example.com/test-1.0.0.tar.gz' } },
        },
      },
    };

    await updateRegistryIndex(index, 'oldsha456', 'publish test-formation@1.0.0', apiOptions);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;
    expect(url).toContain('/contents/index.json');
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body as string);
    expect(body.sha).toBe('oldsha456');
    expect(body.message).toBe('publish test-formation@1.0.0');
    // Verify content is base64-encoded
    const decoded = Buffer.from(body.content, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    expect(parsed.version).toBe(1);
  });

  it('omits sha from body when undefined (first-time create)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ content: { sha: 'newsha' } }),
    } as unknown as Response);

    const index: RegistryIndex = { version: 1, formations: {} };

    await updateRegistryIndex(index, undefined, 'initial publish', apiOptions);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.sha).toBeUndefined();
    expect(body.message).toBe('initial publish');
    expect(body.content).toBeDefined();
  });
});

describe('Auth error', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('401 throws GitHubAuthError', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);

    await expect(getRegistryIndex(apiOptions)).rejects.toThrow(GitHubAuthError);
  });
});

describe('Conflict errors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('409 throws GitHubConflictError', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve('Conflict'),
    } as unknown as Response);

    await expect(getRegistryIndex(apiOptions)).rejects.toThrow(GitHubConflictError);
  });

  it('422 throws GitHubConflictError', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Unprocessable Entity'),
    } as unknown as Response);

    await expect(getRegistryIndex(apiOptions)).rejects.toThrow(GitHubConflictError);
  });
});

describe('SHA concurrency', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updateRegistryIndex sends sha in body for optimistic concurrency', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const index: RegistryIndex = { version: 1, formations: {} };
    await updateRegistryIndex(index, 'concurrency-sha-789', 'test commit', apiOptions);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.sha).toBe('concurrency-sha-789');
  });
});

describe('Rollback scenario', () => {
  it('PublishRollbackError constructor stores originalError, releaseId, and tag', () => {
    const original = new Error('index update failed');
    const err = new PublishRollbackError(
      'Failed to clean up draft release',
      original,
      99999,
      'my-formation@2.0.0',
    );

    expect(err.name).toBe('PublishRollbackError');
    expect(err.message).toContain('Failed to clean up draft release');
    expect(err.originalError).toBe(original);
    expect(err.releaseId).toBe(99999);
    expect(err.tag).toBe('my-formation@2.0.0');
  });
});
