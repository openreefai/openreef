import { describe, it, expect } from 'vitest';
import {
  buildSubagentConfig,
  normalizeAgentTools,
} from '../../src/core/agent-runtime-config.js';
import type { ReefManifest } from '../../src/types/manifest.js';

function buildManifest(overrides?: Partial<ReefManifest>): ReefManifest {
  return {
    reef: '1.0',
    type: 'shoal',
    name: 'test-formation',
    version: '0.1.0',
    description: 'Test formation',
    namespace: 'test',
    agents: {
      lead: {
        source: 'agents/lead',
        description: 'Lead agent',
        tools: { allow: ['sessions_spawn', 'sessions_send'] },
      },
      worker: {
        source: 'agents/worker',
        description: 'Worker agent',
      },
    },
    agentToAgent: {
      lead: ['worker'],
    },
    ...overrides,
  };
}

describe('agent-runtime-config', () => {
  it('normalizes tool aliases to canonical names', () => {
    const normalized = normalizeAgentTools({
      allow: ['spawn_session', 'sessions_send', 'Spawn-Session'],
    });

    expect(normalized).toEqual({
      allow: ['sessions_spawn', 'sessions_send'],
    });
  });

  it('builds subagent allowlist from topology for sessions_spawn agents', () => {
    const manifest = buildManifest({
      agents: {
        lead: {
          source: 'agents/lead',
          description: 'Lead agent',
          tools: { allow: ['spawn_session'] },
        },
        worker: {
          source: 'agents/worker',
          description: 'Worker agent',
        },
      },
    });

    const idMap = new Map<string, string>([
      ['lead', 'test-lead'],
      ['worker', 'test-worker'],
    ]);

    const subagents = buildSubagentConfig(manifest, 'lead', idMap);
    expect(subagents).toEqual({ allowAgents: ['test-worker'] });
  });

  it('returns undefined when agent does not allow sessions_spawn', () => {
    const manifest = buildManifest({
      agents: {
        lead: {
          source: 'agents/lead',
          description: 'Lead agent',
          tools: { allow: ['sessions_send'] },
        },
        worker: {
          source: 'agents/worker',
          description: 'Worker agent',
        },
      },
    });

    const idMap = new Map<string, string>([
      ['lead', 'test-lead'],
      ['worker', 'test-worker'],
    ]);

    const subagents = buildSubagentConfig(manifest, 'lead', idMap);
    expect(subagents).toBeUndefined();
  });
});
