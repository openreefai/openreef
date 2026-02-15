import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  diffStateVsConfig,
  diffStateVsFilesystem,
  diffStateVsCron,
  collectDiscrepancies,
} from '../../src/core/state-differ.js';
import type { FormationState } from '../../src/types/state.js';
import type { CronJob } from '../../src/core/gateway-client.js';

let tempDir: string;

function makeState(overrides?: Partial<FormationState>): FormationState {
  return {
    name: 'test',
    version: '1.0.0',
    namespace: 'testns',
    installedAt: '2025-01-01T00:00:00.000Z',
    agents: {
      triage: {
        id: 'testns-triage',
        slug: 'triage',
        workspace: join(tempDir, 'workspace-testns-triage'),
        files: ['SOUL.md'],
      },
    },
    bindings: [
      {
        agentId: 'testns-triage',
        match: { channel: 'slack' },
      },
    ],
    cronJobs: [],
    variables: {},
    fileHashes: {
      'testns-triage:SOUL.md': 'abc123',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'reef-differ-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('diffStateVsConfig', () => {
  it('returns empty when all agents and bindings present', () => {
    const state = makeState();
    const config = {
      agents: {
        list: [{ id: 'testns-triage', name: 'triage' }],
      },
      bindings: [
        { agentId: 'testns-triage', match: { channel: 'slack' } },
      ],
    };
    const result = diffStateVsConfig(state, config);
    expect(result).toHaveLength(0);
  });

  it('detects missing agent in config', () => {
    const state = makeState();
    const config = {
      agents: { list: [] },
      bindings: [
        { agentId: 'testns-triage', match: { channel: 'slack' } },
      ],
    };
    const result = diffStateVsConfig(state, config);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('agent');
    expect(result[0].type).toBe('missing');
    expect(result[0].fixable).toBe(true);
  });

  it('detects missing binding in config', () => {
    const state = makeState();
    const config = {
      agents: {
        list: [{ id: 'testns-triage' }],
      },
      bindings: [],
    };
    const result = diffStateVsConfig(state, config);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('binding');
    expect(result[0].type).toBe('missing');
    expect(result[0].fixable).toBe(true);
  });

  it('detects missing a2a allow pattern', () => {
    const state = makeState({
      agentToAgent: { wasEnabled: false, allowAdded: true },
    });
    const config = {
      agents: {
        list: [{ id: 'testns-triage' }],
      },
      bindings: [
        { agentId: 'testns-triage', match: { channel: 'slack' } },
      ],
      tools: { agentToAgent: { enabled: true, allow: [] } },
    };
    const result = diffStateVsConfig(state, config);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('a2a');
    expect(result[0].fixable).toBe(true);
  });

  it('no a2a discrepancy when pattern exists', () => {
    const state = makeState({
      agentToAgent: { wasEnabled: false, allowAdded: true },
    });
    const config = {
      agents: {
        list: [{ id: 'testns-triage' }],
      },
      bindings: [
        { agentId: 'testns-triage', match: { channel: 'slack' } },
      ],
      tools: { agentToAgent: { enabled: true, allow: ['testns-*'] } },
    };
    const result = diffStateVsConfig(state, config);
    expect(result).toHaveLength(0);
  });
});

describe('diffStateVsFilesystem', () => {
  it('returns empty when workspace exists and hashes match', async () => {
    await mkdir(join(tempDir, 'workspace-testns-triage'), { recursive: true });
    await writeFile(
      join(tempDir, 'workspace-testns-triage', 'SOUL.md'),
      'content',
    );
    // Use the actual SHA-256 hash of 'content'
    const state = makeState({
      fileHashes: {
        'testns-triage:SOUL.md':
          'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73',
      },
    });
    const result = diffStateVsFilesystem(state);
    expect(result).toHaveLength(0);
  });

  it('detects missing workspace', () => {
    const state = makeState();
    const result = diffStateVsFilesystem(state);
    const wsDiscrepancies = result.filter((d) =>
      d.description.includes('Workspace'),
    );
    expect(wsDiscrepancies).toHaveLength(1);
    expect(wsDiscrepancies[0].needsSource).toBe(true);
  });

  it('detects missing file', async () => {
    await mkdir(join(tempDir, 'workspace-testns-triage'), { recursive: true });
    // SOUL.md is in fileHashes but doesn't exist on disk
    const state = makeState();
    const result = diffStateVsFilesystem(state);
    const fileDiscrepancies = result.filter((d) =>
      d.description.includes('SOUL.md'),
    );
    expect(fileDiscrepancies).toHaveLength(1);
    expect(fileDiscrepancies[0].kind).toBe('file');
    expect(fileDiscrepancies[0].type).toBe('missing');
    expect(fileDiscrepancies[0].needsSource).toBe(true);
  });

  it('detects changed file hash', async () => {
    await mkdir(join(tempDir, 'workspace-testns-triage'), { recursive: true });
    await writeFile(
      join(tempDir, 'workspace-testns-triage', 'SOUL.md'),
      'modified content',
    );
    // State has the hash for original 'content', but file now has 'modified content'
    const state = makeState({
      fileHashes: {
        'testns-triage:SOUL.md':
          'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73',
      },
    });
    const result = diffStateVsFilesystem(state);
    const changedFiles = result.filter((d) => d.type === 'changed');
    expect(changedFiles).toHaveLength(1);
    expect(changedFiles[0].kind).toBe('file');
    expect(changedFiles[0].description).toContain('SOUL.md');
    expect(changedFiles[0].description).toContain('changed');
    expect(changedFiles[0].needsSource).toBe(true);
  });
});

describe('diffStateVsCron', () => {
  it('returns empty when live jobs is null (Gateway unreachable)', () => {
    const state = makeState({
      cronJobs: [
        { id: 'job-1', name: 'reef:testns:triage-0', agentSlug: 'triage' },
      ],
    });
    const result = diffStateVsCron(state, null);
    expect(result).toHaveLength(0);
  });

  it('returns empty when all cron jobs exist', () => {
    const state = makeState({
      cronJobs: [
        { id: 'job-1', name: 'reef:testns:triage-0', agentSlug: 'triage' },
      ],
    });
    const liveJobs: CronJob[] = [
      {
        id: 'job-1',
        name: 'reef:testns:triage-0',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'hi' },
        enabled: true,
        state: 'active',
        createdAtMs: 0,
        updatedAtMs: 0,
      },
    ];
    const result = diffStateVsCron(state, liveJobs);
    expect(result).toHaveLength(0);
  });

  it('detects missing cron job — fixable with schedule data', () => {
    const state = makeState({
      cronJobs: [
        {
          id: 'job-1',
          name: 'reef:testns:triage-0',
          agentSlug: 'triage',
          schedule: '0 9 * * *',
          prompt: 'Run daily',
        },
      ],
    });
    const result = diffStateVsCron(state, []);
    expect(result).toHaveLength(1);
    expect(result[0].fixable).toBe(true);
  });

  it('detects missing cron job — needs source without schedule data', () => {
    const state = makeState({
      cronJobs: [
        { id: 'job-1', name: 'reef:testns:triage-0', agentSlug: 'triage' },
      ],
    });
    const result = diffStateVsCron(state, []);
    expect(result).toHaveLength(1);
    expect(result[0].fixable).toBe(false);
    expect(result[0].needsSource).toBe(true);
  });
});

describe('collectDiscrepancies', () => {
  it('combines all diff sources', async () => {
    // Missing agent in config + missing workspace
    const state = makeState();
    const config = {
      agents: { list: [] },
      bindings: [],
    };
    const result = collectDiscrepancies(state, config, null);
    // Should have at least: missing agent, missing binding, missing workspace, missing file
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('returns empty for healthy formation', async () => {
    await mkdir(join(tempDir, 'workspace-testns-triage'), { recursive: true });
    await writeFile(
      join(tempDir, 'workspace-testns-triage', 'SOUL.md'),
      'content',
    );
    const state = makeState({
      fileHashes: {
        'testns-triage:SOUL.md':
          'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73',
      },
    });
    const config = {
      agents: {
        list: [{ id: 'testns-triage' }],
      },
      bindings: [
        { agentId: 'testns-triage', match: { channel: 'slack' } },
      ],
    };
    const result = collectDiscrepancies(state, config, null);
    expect(result).toHaveLength(0);
  });
});
