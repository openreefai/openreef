import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');

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

describe('reef validate', () => {
  it('validates the bundled template successfully', async () => {
    const result = await runCli('validate', TEMPLATE);
    expect(result.code).toBe(0);
  });

  it('outputs JSON with --json flag', async () => {
    const result = await runCli('validate', TEMPLATE, '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toBeInstanceOf(Array);
  });

  it('fails on a directory without reef.json', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      const result = await runCli('validate', tempDir);
      expect(result.code).not.toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails on invalid manifest JSON', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      await writeFile(join(tempDir, 'reef.json'), '{bad json}');
      const result = await runCli('validate', tempDir);
      expect(result.code).not.toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports structural errors for missing agent directories', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      // Write a valid schema manifest but with no agent directories
      const manifest = {
        reef: '1.0',
        type: 'solo',
        name: 'test',
        version: '0.1.0',
        description: 'Test formation',
        namespace: 'test',
        agents: {
          worker: { source: 'agents/worker', description: 'Worker agent' },
        },
      };
      await writeFile(join(tempDir, 'reef.json'), JSON.stringify(manifest));
      const result = await runCli('validate', tempDir, '--json');
      expect(result.code).not.toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.valid).toBe(false);
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ code: 'AGENT_DIR_MISSING' }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports structural errors for missing SOUL.md', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      const manifest = {
        reef: '1.0',
        type: 'solo',
        name: 'test',
        version: '0.1.0',
        description: 'Test formation',
        namespace: 'test',
        agents: {
          worker: { source: 'agents/worker', description: 'Worker agent' },
        },
      };
      await writeFile(join(tempDir, 'reef.json'), JSON.stringify(manifest));
      await mkdir(join(tempDir, 'agents', 'worker'), { recursive: true });
      // No SOUL.md
      const result = await runCli('validate', tempDir, '--json');
      expect(result.code).not.toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ code: 'SOUL_MD_MISSING' }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
