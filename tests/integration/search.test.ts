import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerSearchCommand } from '../../src/commands/search.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runSearch(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerSearchCommand(program);
  await program.parseAsync(['node', 'reef', 'search', ...args]);
}

describe('reef search', () => {
  it('successful search with results: constructs URL with q, limit, type, sort', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          total: 2,
          formations: [
            {
              name: 'daily-ops',
              description: 'Daily operations formation',
              type: 'shoal',
              latest_version: '1.2.0',
              total_downloads: 42,
            },
            {
              name: 'code-review',
              description: 'Code review formation',
              type: 'solo',
              latest_version: '0.5.0',
              total_downloads: 7,
            },
          ],
        }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSearch(['agents', '--type', 'shoal', '--sort', 'downloads', '--limit', '5']);

    // Verify fetch was called once
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    // Verify URL construction
    const call = vi.mocked(fetch).mock.calls[0];
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe('/api/formations');
    expect(url.searchParams.get('q')).toBe('agents');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('type')).toBe('shoal');
    expect(url.searchParams.get('sort')).toBe('downloads');

    // Verify output includes formation names
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('daily-ops');
    expect(output).toContain('code-review');
    expect(output).toContain('2 results');

    logSpy.mockRestore();
  });

  it('empty results: zero formations', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          total: 0,
          formations: [],
        }),
    } as unknown as Response);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSearch(['nonexistent-thing']);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('0 results');

    logSpy.mockRestore();
  });

  it('API error response: non-200 status exits with error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as unknown as Response);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    try {
      await runSearch(['agents']);
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    }

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Search failed'),
    );

    errSpy.mockRestore();
    mockExit.mockRestore();
  });
});
