import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportFormation } from '../../src/commands/export.js';

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-export-test-'));
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function writeStateWithSource(
  namespace: string,
  name: string,
  sourcePath: string,
): Promise<void> {
  const reefDir = join(tempHome, '.reef');
  await mkdir(reefDir, { recursive: true });
  await writeFile(
    join(reefDir, `${namespace}--${name}.state.json`),
    JSON.stringify({
      name,
      version: '1.0.0',
      namespace,
      installedAt: '2025-01-01T00:00:00.000Z',
      agents: {},
      bindings: [],
      cronJobs: [],
      variables: {},
      fileHashes: {},
      sourcePath,
    }),
  );
}

async function createSourceDir(
  name: string,
): Promise<string> {
  const srcDir = join(tempHome, `source-${name}`);
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'reef.json'), JSON.stringify({ name }));
  await mkdir(join(srcDir, 'agents', 'worker'), { recursive: true });
  await writeFile(join(srcDir, 'agents', 'worker', 'SOUL.md'), '# Worker');
  return srcDir;
}

function captureConsole(): {
  logs: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(' '));
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

describe('reef export', () => {
  it('exports installed formation to default directory', async () => {
    const srcDir = await createSourceDir('myapp');
    await writeStateWithSource('ns', 'myapp', srcDir);

    const outputDir = join(tempHome, 'myapp');
    const cap = captureConsole();
    try {
      // Change cwd for default output
      const origCwd = process.cwd();
      process.chdir(tempHome);
      try {
        await exportFormation('ns/myapp', {});
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      cap.restore();
    }

    expect(existsSync(outputDir)).toBe(true);
    expect(existsSync(join(outputDir, 'reef.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'agents', 'worker', 'SOUL.md'))).toBe(true);
    const content = await readFile(join(outputDir, 'reef.json'), 'utf-8');
    expect(JSON.parse(content).name).toBe('myapp');
  });

  it('exports with --output custom path', async () => {
    const srcDir = await createSourceDir('myapp');
    await writeStateWithSource('ns', 'myapp', srcDir);

    const outputDir = join(tempHome, 'custom-output');
    const cap = captureConsole();
    try {
      await exportFormation('ns/myapp', { output: outputDir });
    } finally {
      cap.restore();
    }

    expect(existsSync(join(outputDir, 'reef.json'))).toBe(true);
  });

  it('errors when output directory exists without --force', async () => {
    const srcDir = await createSourceDir('myapp');
    await writeStateWithSource('ns', 'myapp', srcDir);

    const outputDir = join(tempHome, 'existing-output');
    await mkdir(outputDir, { recursive: true });

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await exportFormation('ns/myapp', { output: outputDir });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.errors.join('\n')).toContain('already exists');

    mockExit.mockRestore();
  });

  it('--force overwrites existing directory', async () => {
    const srcDir = await createSourceDir('myapp');
    await writeStateWithSource('ns', 'myapp', srcDir);

    const outputDir = join(tempHome, 'existing-output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'old-file.txt'), 'should be replaced');

    const cap = captureConsole();
    try {
      await exportFormation('ns/myapp', { output: outputDir, force: true });
    } finally {
      cap.restore();
    }

    expect(existsSync(join(outputDir, 'reef.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'old-file.txt'))).toBe(false);
  });

  it('errors for non-existent formation', async () => {
    await mkdir(join(tempHome, '.reef'), { recursive: true });

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await exportFormation('ns/nonexistent', {});
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.errors.join('\n')).toContain('not found');

    mockExit.mockRestore();
  });

  it('errors when sourcePath is missing/dead', async () => {
    await writeStateWithSource('ns', 'myapp', join(tempHome, 'dead-path'));

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await exportFormation('ns/myapp', { output: join(tempHome, 'out') });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.errors.join('\n')).toContain('no longer available');

    mockExit.mockRestore();
  });

  it('errors when output path equals source path', async () => {
    const srcDir = await createSourceDir('myapp');
    await writeStateWithSource('ns', 'myapp', srcDir);

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await exportFormation('ns/myapp', { output: srcDir });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.errors.join('\n')).toContain('same as the source');

    mockExit.mockRestore();
  });

  it('errors when output path is child of source path', async () => {
    const srcDir = await createSourceDir('myapp');
    await writeStateWithSource('ns', 'myapp', srcDir);

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await exportFormation('ns/myapp', { output: join(srcDir, 'subdir') });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.errors.join('\n')).toContain('inside the source');

    mockExit.mockRestore();
  });
});
