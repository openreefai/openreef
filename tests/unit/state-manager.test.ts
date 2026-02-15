import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadState,
  saveState,
  deleteState,
  listStates,
  computeFileHash,
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
});
