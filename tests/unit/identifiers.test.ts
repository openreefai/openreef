import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseIdentifier,
  resolveFormationState,
  FormationNotFoundError,
  AmbiguousFormationError,
} from '../../src/utils/identifiers.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'reef-id-test-'));
  process.env.OPENCLAW_STATE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe('parseIdentifier', () => {
  it('parses namespace/name', () => {
    expect(parseIdentifier('support/support-team')).toEqual({
      namespace: 'support',
      name: 'support-team',
    });
  });

  it('parses bare name (no namespace)', () => {
    expect(parseIdentifier('support-team')).toEqual({
      name: 'support-team',
    });
  });

  it('handles multiple slashes — first is the split', () => {
    expect(parseIdentifier('a/b/c')).toEqual({
      namespace: 'a',
      name: 'b/c',
    });
  });
});

describe('resolveFormationState', () => {
  async function writeState(namespace: string, name: string) {
    const reefDir = join(tempDir, '.reef');
    await mkdir(reefDir, { recursive: true });
    const state = {
      name,
      version: '1.0.0',
      namespace,
      installedAt: '2025-01-01T00:00:00.000Z',
      agents: {
        triage: {
          id: `${namespace}-triage`,
          slug: 'triage',
          workspace: '/tmp/ws',
          files: [],
        },
      },
      bindings: [],
      cronJobs: [],
      variables: {},
      fileHashes: {},
    };
    await writeFile(
      join(reefDir, `${namespace}--${name}.state.json`),
      JSON.stringify(state),
    );
    return state;
  }

  it('resolves namespace/name directly', async () => {
    await writeState('support', 'team');
    const state = await resolveFormationState('support/team');
    expect(state.namespace).toBe('support');
    expect(state.name).toBe('team');
  });

  it('throws FormationNotFoundError for missing namespace/name', async () => {
    await expect(
      resolveFormationState('nonexistent/name'),
    ).rejects.toThrow(FormationNotFoundError);
  });

  it('resolves bare name when unique', async () => {
    await writeState('support', 'team');
    const state = await resolveFormationState('team');
    expect(state.namespace).toBe('support');
    expect(state.name).toBe('team');
  });

  it('throws FormationNotFoundError for missing bare name', async () => {
    await expect(
      resolveFormationState('nonexistent'),
    ).rejects.toThrow(FormationNotFoundError);
  });

  it('throws AmbiguousFormationError when bare name matches multiple', async () => {
    await writeState('ns1', 'team');
    await writeState('ns2', 'team');
    try {
      await resolveFormationState('team');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousFormationError);
      expect((err as AmbiguousFormationError).matches).toHaveLength(2);
    }
  });

  it('FormationNotFoundError has descriptive message', async () => {
    try {
      await resolveFormationState('missing-formation');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('missing-formation');
    }
  });
});
