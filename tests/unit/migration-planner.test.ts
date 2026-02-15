import { describe, it, expect } from 'vitest';
import { computeMigrationPlan } from '../../src/core/migration-planner.js';
import type { FormationState } from '../../src/types/state.js';

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
        workspace: '/tmp/ws-triage',
        files: ['SOUL.md'],
      },
    },
    bindings: [
      { agentId: 'testns-triage', match: { channel: 'slack' } },
    ],
    cronJobs: [],
    variables: {},
    fileHashes: {
      'testns-triage:SOUL.md': 'hash-a',
    },
    ...overrides,
  };
}

describe('computeMigrationPlan', () => {
  it('returns empty plan when nothing changed', () => {
    const state = makeState();
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.isEmpty).toBe(true);
  });

  it('detects added agent', () => {
    const state = makeState();
    const manifest = {
      reef: '1.0' as const,
      type: 'shoal' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
        researcher: {
          source: 'agents/researcher',
          description: 'Researcher',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
    };
    const idMap = new Map([
      ['triage', 'testns-triage'],
      ['researcher', 'testns-researcher'],
    ]);
    const newHashes = {
      'testns-triage:SOUL.md': 'hash-a',
      'testns-researcher:SOUL.md': 'hash-b',
    };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.isEmpty).toBe(false);
    expect(plan.agents.find((a) => a.slug === 'researcher')?.type).toBe('add');
    expect(plan.agents.find((a) => a.slug === 'triage')?.type).toBe('unchanged');
  });

  it('detects removed agent', () => {
    const state = makeState({
      agents: {
        triage: {
          id: 'testns-triage',
          slug: 'triage',
          workspace: '/tmp/ws-triage',
          files: ['SOUL.md'],
        },
        oldagent: {
          id: 'testns-oldagent',
          slug: 'oldagent',
          workspace: '/tmp/ws-oldagent',
          files: ['SOUL.md'],
        },
      },
      fileHashes: {
        'testns-triage:SOUL.md': 'hash-a',
        'testns-oldagent:SOUL.md': 'hash-b',
      },
    });
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.isEmpty).toBe(false);
    expect(plan.agents.find((a) => a.slug === 'oldagent')?.type).toBe('remove');
  });

  it('detects changed files', () => {
    const state = makeState();
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    // Different hash = file changed
    const newHashes = { 'testns-triage:SOUL.md': 'hash-CHANGED' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.isEmpty).toBe(false);
    const triageChange = plan.agents.find((a) => a.slug === 'triage');
    expect(triageChange?.type).toBe('update');
    expect(triageChange?.changedFiles).toContain('SOUL.md');
  });

  it('detects added binding', () => {
    const state = makeState({ bindings: [] });
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.bindings).toHaveLength(1);
    expect(plan.bindings[0].type).toBe('add');
  });

  it('detects removed binding', () => {
    const state = makeState();
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      // No bindings in new manifest
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.bindings).toHaveLength(1);
    expect(plan.bindings[0].type).toBe('remove');
  });

  it('detects version change', () => {
    const state = makeState();
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '2.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.versionChange).toEqual({ from: '1.0.0', to: '2.0.0' });
  });

  it('detects cron job changes', () => {
    const state = makeState({
      cronJobs: [
        {
          id: 'job-1',
          name: 'reef:testns:triage-0',
          agentSlug: 'triage',
          schedule: '0 9 * * *',
          prompt: 'Hello',
        },
      ],
    });
    const manifest = {
      reef: '1.0' as const,
      type: 'solo' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
      cron: [
        {
          schedule: '0 10 * * *', // Changed schedule
          agent: 'triage',
          prompt: 'Hello',
        },
      ],
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.cron).toHaveLength(1);
    expect(plan.cron[0].type).toBe('update');
  });

  it('a2a edges use reapply for v0.2.0 state without agentToAgentEdges', () => {
    const state = makeState({
      // No agentToAgentEdges — simulates v0.2.0 state
    });
    const manifest = {
      reef: '1.0' as const,
      type: 'shoal' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
      agentToAgent: { triage: ['manager'] },
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.a2a).toHaveLength(1);
    expect(plan.a2a[0].type).toBe('reapply');
  });

  it('a2a edges detect additions with Phase 3 state', () => {
    const state = makeState({
      agentToAgentEdges: { triage: ['manager'] },
    });
    const manifest = {
      reef: '1.0' as const,
      type: 'shoal' as const,
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Triage',
        },
      },
      bindings: [{ channel: 'slack', agent: 'triage' }],
      agentToAgent: { triage: ['manager', 'researcher'] },
    };
    const idMap = new Map([['triage', 'testns-triage']]);
    const newHashes = { 'testns-triage:SOUL.md': 'hash-a' };

    const plan = computeMigrationPlan(state, manifest, 'testns', idMap, newHashes);
    expect(plan.a2a.find((e) => e.to === 'researcher')?.type).toBe('add');
  });
});
