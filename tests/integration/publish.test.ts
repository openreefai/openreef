import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publish } from '../../src/commands/publish.js';

let tempHome: string;
let formationDir: string;

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
  process.env.REEF_TOKEN = 'reef_tok_test_123';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.REEF_TOKEN;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef publish (Tide API)', () => {
  it('happy path: validates, packs, and publishes to Tide API', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          url: 'https://tide.openreef.ai/formations/test-formation',
          version: '1.0.0',
        }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await publish(formationDir, { yes: true });

    // Verify fetch was called once (the publish POST)
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);

    // Verify it was a POST to the publish endpoint
    const call = vi.mocked(fetch).mock.calls[0];
    const url = call[0] as string;
    const opts = call[1] as RequestInit;
    expect(url).toContain('/api/formations/test-formation/publish');
    expect(opts.method).toBe('POST');

    // Verify Authorization header
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer reef_tok_test_123');

    // Verify body is FormData
    expect(opts.body).toBeInstanceOf(FormData);

    logSpy.mockRestore();
  });

  it('version conflict: 409 response shows version exists error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          error: 'Version 1.0.0 already exists',
        }),
    } as unknown as Response);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    logSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('no token: errors with missing token message', async () => {
    delete process.env.REEF_TOKEN;

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
      expect.stringContaining('No Tide API token'),
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

  it('auth failure: 401 response shows authentication error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: 'Invalid token',
        }),
    } as unknown as Response);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      expect.stringContaining('Authentication failed'),
    );

    errSpy.mockRestore();
    logSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('forbidden: 403 response shows permission error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: () =>
        Promise.resolve({
          error: 'Name is reserved',
        }),
    } as unknown as Response);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      expect.stringContaining('Forbidden'),
    );

    errSpy.mockRestore();
    logSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('uses --registry flag when provided', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ version: '1.0.0' }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await publish(formationDir, {
      yes: true,
      registry: 'https://custom-registry.example.com',
    });

    const call = vi.mocked(fetch).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain('https://custom-registry.example.com/api/formations/');

    logSpy.mockRestore();
  });
});
