import { describe, it, expect, vi } from 'vitest';
import { lock } from '../../src/commands/lock.js';

describe('reef lock', () => {
  it('prints ClawHub message and exits with code 1', async () => {
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) =>
      errors.push(args.map(String).join(' '));

    try {
      await lock('some-formation');
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      console.error = origErr;
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toContain('ClawHub');

    mockExit.mockRestore();
  });
});
