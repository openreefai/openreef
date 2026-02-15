import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadState,
  saveState,
  deleteState,
  listStates,
  computeFileHash,
  persistSourceSnapshot,
  deleteSourceSnapshot,
  sourceSnapshotDir,
} from '../../src/core/state-manager.js';
import type { FormationState } from '../../src/types/state.js';

let tempDir: string;
let env: NodeJS.ProcessEnv;

function makeState(
  namespace: string,
  name: string,
  overrides?: Partial<FormationState>,
): FormationState {
  return {
    name,
    version: '1.0.0',
    namespace,
    installedAt: new Date().toISOString(),
    agents: {},
    bindings: [],
    cronJobs: [],
    variables: {},
    fileHashes: {},
    ...overrides,
  };
}

describe('state-manager', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-state-test-'));
    env = { OPENCLAW_STATE_DIR: tempDir };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── loadState ────────────────────────────────────────────────────
  describe('loadState', () => {
    it('returns null if state file does not exist', async () => {
      const result = await loadState('ns', 'missing', env);
      expect(result).toBeNull();
    });

    it('returns state if file exists', async () => {
      const state = makeState('ns', 'myformation');
      await saveState(state, env);

      const loaded = await loadState('ns', 'myformation', env);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('myformation');
      expect(loaded!.namespace).toBe('ns');
      expect(loaded!.version).toBe('1.0.0');
    });
  });

  // ─── saveState ────────────────────────────────────────────────────
  describe('saveState', () => {
    it('writes to $STATE_DIR/.reef/{ns}--{name}.state.json', async () => {
      const state = makeState('ns', 'test-formation');
      await saveState(state, env);

      const loaded = await loadState('ns', 'test-formation', env);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('test-formation');
    });

    it('creates .reef directory if it does not exist', async () => {
      const state = makeState('ns', 'test');
      // .reef dir doesn't exist yet in the temp dir
      await expect(saveState(state, env)).resolves.toBeUndefined();

      const loaded = await loadState('ns', 'test', env);
      expect(loaded).not.toBeNull();
    });

    it('overwrites existing state', async () => {
      const state1 = makeState('ns', 'test', { version: '1.0.0' });
      await saveState(state1, env);

      const state2 = makeState('ns', 'test', { version: '2.0.0' });
      await saveState(state2, env);

      const loaded = await loadState('ns', 'test', env);
      expect(loaded!.version).toBe('2.0.0');
    });
  });

  // ─── deleteState ──────────────────────────────────────────────────
  describe('deleteState', () => {
    it('removes the state file', async () => {
      const state = makeState('ns', 'todelete');
      await saveState(state, env);

      await deleteState('ns', 'todelete', env);

      const loaded = await loadState('ns', 'todelete', env);
      expect(loaded).toBeNull();
    });

    it('no error if file is missing', async () => {
      await expect(
        deleteState('ns', 'nonexistent', env),
      ).resolves.toBeUndefined();
    });
  });

  // ─── listStates ───────────────────────────────────────────────────
  describe('listStates', () => {
    it('returns empty array if .reef dir is missing', async () => {
      const result = await listStates(env);
      expect(result).toEqual([]);
    });

    it('reads all .state.json files', async () => {
      const state1 = makeState('ns', 'formation-a');
      const state2 = makeState('ns', 'formation-b');
      await saveState(state1, env);
      await saveState(state2, env);

      const states = await listStates(env);
      expect(states).toHaveLength(2);
      const names = states.map((s) => s.name).sort();
      expect(names).toEqual(['formation-a', 'formation-b']);
    });

    it('returns states from multiple namespaces', async () => {
      await saveState(makeState('ns1', 'a'), env);
      await saveState(makeState('ns2', 'b'), env);

      const states = await listStates(env);
      expect(states).toHaveLength(2);
      const namespaces = states.map((s) => s.namespace).sort();
      expect(namespaces).toEqual(['ns1', 'ns2']);
    });
  });

  // ─── computeFileHash ─────────────────────────────────────────────
  describe('computeFileHash', () => {
    it('returns SHA-256 hex', () => {
      const content = Buffer.from('hello world');
      const hash = computeFileHash(content);

      // SHA-256 produces 64 hex characters
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces consistent hashes', () => {
      const content = Buffer.from('test content');
      const hash1 = computeFileHash(content);
      const hash2 = computeFileHash(content);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different content', () => {
      const hash1 = computeFileHash(Buffer.from('content A'));
      const hash2 = computeFileHash(Buffer.from('content B'));
      expect(hash1).not.toBe(hash2);
    });
  });

  // ─── persistSourceSnapshot ─────────────────────────────────────
  describe('persistSourceSnapshot', () => {
    it('copies formation source to snapshot dir', async () => {
      const srcDir = join(tempDir, 'formation-src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'reef.json'), '{"name":"test"}');
      await mkdir(join(srcDir, 'agents', 'worker'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'worker', 'SOUL.md'), '# Worker');

      const result = await persistSourceSnapshot(srcDir, 'ns', 'test', env);

      expect(result).toBe(sourceSnapshotDir('ns', 'test', env));
      expect(existsSync(join(result, 'reef.json'))).toBe(true);
      expect(existsSync(join(result, 'agents', 'worker', 'SOUL.md'))).toBe(true);
      const content = await readFile(join(result, 'reef.json'), 'utf-8');
      expect(content).toBe('{"name":"test"}');
    });

    it('atomically replaces old snapshot', async () => {
      const srcDir = join(tempDir, 'formation-src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'reef.json'), '{"version":"1.0"}');

      await persistSourceSnapshot(srcDir, 'ns', 'test', env);

      // Update source and re-snapshot
      await writeFile(join(srcDir, 'reef.json'), '{"version":"2.0"}');
      const result = await persistSourceSnapshot(srcDir, 'ns', 'test', env);

      const content = await readFile(join(result, 'reef.json'), 'utf-8');
      expect(content).toBe('{"version":"2.0"}');
    });

    it('no-op when formationPath equals snapshotDir', async () => {
      const snapshotDir = sourceSnapshotDir('ns', 'test', env);
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(join(snapshotDir, 'reef.json'), '{"name":"test"}');

      const result = await persistSourceSnapshot(snapshotDir, 'ns', 'test', env);
      expect(result).toBe(snapshotDir);
      // File should still exist unchanged
      const content = await readFile(join(result, 'reef.json'), 'utf-8');
      expect(content).toBe('{"name":"test"}');
    });

    it('throws on path overlap (containment)', async () => {
      const snapshotDir = sourceSnapshotDir('ns', 'test', env);
      const childPath = join(snapshotDir, 'subdir');
      await mkdir(childPath, { recursive: true });

      await expect(
        persistSourceSnapshot(childPath, 'ns', 'test', env),
      ).rejects.toThrow('paths overlap');
    });
  });

  // ─── deleteSourceSnapshot ──────────────────────────────────────
  describe('deleteSourceSnapshot', () => {
    it('removes the snapshot directory', async () => {
      const srcDir = join(tempDir, 'formation-src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'reef.json'), '{}');

      await persistSourceSnapshot(srcDir, 'ns', 'test', env);
      const snapshotDir = sourceSnapshotDir('ns', 'test', env);
      expect(existsSync(snapshotDir)).toBe(true);

      await deleteSourceSnapshot('ns', 'test', env);
      expect(existsSync(snapshotDir)).toBe(false);
    });

    it('no error if snapshot does not exist', async () => {
      await expect(
        deleteSourceSnapshot('ns', 'nonexistent', env),
      ).resolves.toBeUndefined();
    });
  });
});
