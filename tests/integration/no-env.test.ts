import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../../src/index.js';

// Mock all command modules to capture options passed to them
vi.mock('../../src/commands/install.js', () => ({
  install: vi.fn(async () => {}),
}));
vi.mock('../../src/commands/update.js', () => ({
  update: vi.fn(async () => {}),
}));
vi.mock('../../src/commands/diff.js', () => ({
  diff: vi.fn(async () => {}),
}));

import { install } from '../../src/commands/install.js';
import { update } from '../../src/commands/update.js';
import { diff } from '../../src/commands/diff.js';

describe('--no-env flag mapping', () => {
  beforeEach(() => {
    vi.mocked(install).mockClear();
    vi.mocked(update).mockClear();
    vi.mocked(diff).mockClear();
  });

  it('reef install --no-env sets noEnv to true', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'install', './foo', '--no-env', '--yes']);
    expect(install).toHaveBeenCalledOnce();
    const opts = vi.mocked(install).mock.calls[0][1];
    expect(opts.noEnv).toBe(true);
  });

  it('reef install without --no-env sets noEnv to false', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'install', './foo', '--yes']);
    expect(install).toHaveBeenCalledOnce();
    const opts = vi.mocked(install).mock.calls[0][1];
    expect(opts.noEnv).toBe(false);
  });

  it('reef update --no-env sets noEnv to true', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'update', './foo', '--no-env', '--yes']);
    expect(update).toHaveBeenCalledOnce();
    const opts = vi.mocked(update).mock.calls[0][1];
    expect(opts.noEnv).toBe(true);
  });

  it('reef update without --no-env sets noEnv to false', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'update', './foo', '--yes']);
    expect(update).toHaveBeenCalledOnce();
    const opts = vi.mocked(update).mock.calls[0][1];
    expect(opts.noEnv).toBe(false);
  });

  it('reef diff --no-env sets noEnv to true', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'diff', './foo', '--no-env']);
    expect(diff).toHaveBeenCalledOnce();
    const opts = vi.mocked(diff).mock.calls[0][1];
    expect(opts.noEnv).toBe(true);
  });

  it('reef diff without --no-env sets noEnv to false', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'diff', './foo']);
    expect(diff).toHaveBeenCalledOnce();
    const opts = vi.mocked(diff).mock.calls[0][1];
    expect(opts.noEnv).toBe(false);
  });

  it('noEnv is always boolean, never undefined', async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'reef', 'install', './foo', '--yes']);
    const installOpts = vi.mocked(install).mock.calls[0][1];
    expect(typeof installOpts.noEnv).toBe('boolean');
  });
});
