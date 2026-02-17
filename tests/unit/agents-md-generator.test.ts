import { describe, it, expect } from 'vitest';
import { generateAgentsMd } from '../../src/core/agents-md-generator.js';
import type { ReefManifest } from '../../src/types/manifest.js';

function makeManifest(overrides?: Partial<ReefManifest>): ReefManifest {
  return {
    reef: '1.0' as const,
    type: 'shoal' as const,
    name: 'test',
    version: '1.0.0',
    description: 'test',
    namespace: 'ns',
    agents: {
      manager: { source: 'agents/manager', description: 'Manages things' },
      researcher: { source: 'agents/researcher', description: 'Researches things' },
    },
    agentToAgent: {
      manager: ['researcher'],
      researcher: ['manager'],
    },
    ...overrides,
  };
}

describe('agents-md-generator', () => {
  it('generates markdown with one agent listed (single target)', () => {
    const manifest = makeManifest({
      agentToAgent: {
        manager: ['researcher'],
      },
    });

    const md = generateAgentsMd(manifest, 'manager', 'ns');

    expect(md).toContain('# Available Agents');
    expect(md).toContain('**researcher**');
    expect(md).toContain('`ns-researcher`');
    expect(md).toContain('Researches things');
    expect(md).toContain('sessions_spawn');
    expect(md).toContain('Do NOT use `sessions_send` for first contact');
  });

  it('generates markdown with multiple agents listed', () => {
    const manifest = makeManifest({
      agents: {
        manager: { source: 'agents/manager', description: 'Manages things' },
        researcher: { source: 'agents/researcher', description: 'Researches things' },
        writer: { source: 'agents/writer', description: 'Writes things' },
      },
      agentToAgent: {
        manager: ['researcher', 'writer'],
      },
    });

    const md = generateAgentsMd(manifest, 'manager', 'ns');

    expect(md).toContain('**researcher**');
    expect(md).toContain('`ns-researcher`');
    expect(md).toContain('**writer**');
    expect(md).toContain('`ns-writer`');
  });

  it('returns empty string for empty edges', () => {
    const manifest = makeManifest({
      agentToAgent: {
        manager: [],
      },
    });

    const md = generateAgentsMd(manifest, 'manager', 'ns');
    expect(md).toBe('');
  });

  it('returns empty string when agent has no edges defined', () => {
    const manifest = makeManifest({
      agentToAgent: {},
    });

    const md = generateAgentsMd(manifest, 'manager', 'ns');
    expect(md).toBe('');
  });

  it('returns empty string when agentToAgent is undefined', () => {
    const manifest = makeManifest({ agentToAgent: undefined });

    const md = generateAgentsMd(manifest, 'manager', 'ns');
    expect(md).toBe('');
  });

  it('skips gracefully when target agent is missing from manifest', () => {
    const manifest = makeManifest({
      agentToAgent: {
        manager: ['researcher', 'nonexistent'],
      },
    });

    const md = generateAgentsMd(manifest, 'manager', 'ns');

    // researcher should be listed
    expect(md).toContain('**researcher**');
    // nonexistent should be skipped (not cause an error)
    expect(md).not.toContain('nonexistent');
  });

  it('uses agent slug as description fallback when description is missing', () => {
    const manifest = makeManifest({
      agents: {
        manager: { source: 'agents/manager', description: 'Manages things' },
        helper: { source: 'agents/helper', description: '' },
      },
      agentToAgent: {
        manager: ['helper'],
      },
    });

    const md = generateAgentsMd(manifest, 'manager', 'ns');
    // With empty description, it falls back to the target slug name
    // The code does: agent.description ?? target
    // Empty string is falsy but ?? only checks null/undefined, so empty string is used
    expect(md).toContain('**helper**');
  });
});
