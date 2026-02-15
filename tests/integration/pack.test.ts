import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extract } from 'tar';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');

const cleanupDirs: string[] = [];

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('node', [CLI, ...args]);
    return { ...result, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('reef pack', () => {
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanupDirs.length = 0;
  });

  it('creates a .tar.gz for a valid formation', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'reef-pack-'));
    cleanupDirs.push(outputDir);

    const result = await runCli('pack', TEMPLATE, '--output', outputDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('.reef.tar.gz');

    // Verify the archive exists
    const expectedFile = join(outputDir, 'my-formation-0.1.0.reef.tar.gz');
    await expect(access(expectedFile)).resolves.toBeUndefined();
  });

  it('archive can be extracted with correct contents', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'reef-pack-'));
    cleanupDirs.push(outputDir);

    await runCli('pack', TEMPLATE, '--output', outputDir);

    const extractDir = join(outputDir, 'extracted');
    await mkdir(extractDir, { recursive: true });
    const archivePath = join(outputDir, 'my-formation-0.1.0.reef.tar.gz');

    await extract({ file: archivePath, cwd: extractDir });

    // Verify key files exist in extracted contents
    await expect(access(join(extractDir, 'reef.json'))).resolves.toBeUndefined();
    await expect(
      access(join(extractDir, 'agents', 'manager', 'SOUL.md')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(extractDir, 'agents', 'researcher', 'SOUL.md')),
    ).resolves.toBeUndefined();
  });

  it('fails when formation has validation errors', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-pack-'));
    cleanupDirs.push(tempDir);

    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(tempDir, 'reef.json'), '{"reef": "1.0"}');

    const result = await runCli('pack', tempDir);
    expect(result.code).not.toBe(0);
  });
});
