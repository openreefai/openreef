import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest, ManifestLoadError } from '../../src/core/manifest-loader.js';

let tempDir: string;

describe('manifest-loader', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a valid reef.json', async () => {
    const manifest = {
      reef: '1.0',
      type: 'team',
      name: 'test',
      version: '0.1.0',
      description: 'Test',
      namespace: 'test',
      agents: {
        worker: { source: 'agents/worker', description: 'Worker' },
      },
    };
    await writeFile(join(tempDir, 'reef.json'), JSON.stringify(manifest));
    const result = await loadManifest(tempDir);
    expect(result.name).toBe('test');
    expect(result.agents.worker.description).toBe('Worker');
  });

  it('throws ManifestLoadError on missing file', async () => {
    await expect(loadManifest(tempDir)).rejects.toThrow(ManifestLoadError);
  });

  it('throws ManifestLoadError on invalid JSON', async () => {
    await writeFile(join(tempDir, 'reef.json'), '{not valid json}');
    await expect(loadManifest(tempDir)).rejects.toThrow(ManifestLoadError);
  });
});
