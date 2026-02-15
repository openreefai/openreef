import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

let tempDir: string;
const cleanupDirs: string[] = [];

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [CLI, ...args], { cwd: tempDir });
}

describe('reef init', () => {
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanupDirs.length = 0;
  });

  it('scaffolds a new formation', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-init-'));
    cleanupDirs.push(tempDir);

    const name = 'test-formation';
    await runCli('init', name, '--yes');

    const formationDir = join(tempDir, name);
    cleanupDirs.push(formationDir);

    // Check reef.json was created and updated
    const manifestRaw = await readFile(join(formationDir, 'reef.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.name).toBe(name);
    expect(manifest.namespace).toBe(name);
    expect(manifest.type).toBe('team');

    // Check .env.example was generated
    const envExample = await readFile(join(formationDir, '.env.example'), 'utf-8');
    expect(envExample).toContain('OPENAI_API_KEY');
    expect(envExample).toContain('MISSION_GOAL');

    // Check agent directories exist
    await expect(access(join(formationDir, 'agents', 'manager', 'SOUL.md'))).resolves.toBeUndefined();
    await expect(access(join(formationDir, 'agents', 'researcher', 'SOUL.md'))).resolves.toBeUndefined();
  });

  it('uses custom type flag', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-init-'));
    cleanupDirs.push(tempDir);

    const name = 'solo-formation';
    await runCli('init', name, '--type', 'solo', '--yes');

    const formationDir = join(tempDir, name);
    cleanupDirs.push(formationDir);

    const manifestRaw = await readFile(join(formationDir, 'reef.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.type).toBe('solo');
  });

  it('fails when directory already exists', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-init-'));
    cleanupDirs.push(tempDir);

    const name = 'test-formation';
    await runCli('init', name, '--yes');
    const formationDir = join(tempDir, name);
    cleanupDirs.push(formationDir);

    // Try again — should fail
    await expect(runCli('init', name, '--yes')).rejects.toThrow();
  });
});
