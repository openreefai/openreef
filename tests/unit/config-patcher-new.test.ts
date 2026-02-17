import { describe, it, expect } from 'vitest';
import {
  pruneMatchObject,
  recomputeAgentToAgent,
} from '../../src/core/config-patcher.js';

describe('config-patcher: pruneMatchObject', () => {
  it('strips undefined fields', () => {
    const match = { channel: 'slack', accountId: undefined, peer: undefined };
    const result = pruneMatchObject(match);
    expect(result).toEqual({ channel: 'slack' });
  });

  it('strips null fields', () => {
    const match = { channel: 'telegram', guildId: null, teamId: null };
    const result = pruneMatchObject(match);
    expect(result).toEqual({ channel: 'telegram' });
  });

  it('strips empty string fields', () => {
    const match = { channel: 'discord', accountId: '', guildId: '' };
    const result = pruneMatchObject(match);
    expect(result).toEqual({ channel: 'discord' });
  });

  it('preserves valid fields', () => {
    const match = {
      channel: 'slack',
      accountId: '*',
      peer: { kind: 'channel', id: '#ops' },
      guildId: '12345',
    };
    const result = pruneMatchObject(match);
    expect(result).toEqual({
      channel: 'slack',
      accountId: '*',
      peer: { kind: 'channel', id: '#ops' },
      guildId: '12345',
    });
  });

  it('recursively prunes nested objects (peer)', () => {
    const match = {
      channel: 'slack',
      peer: { kind: '', id: '' },
    };
    const result = pruneMatchObject(match);
    // peer has no remaining fields after pruning, so it should be dropped
    expect(result).toEqual({ channel: 'slack' });
  });

  it('keeps peer when at least one sub-field is valid', () => {
    const match = {
      channel: 'slack',
      peer: { kind: 'channel', id: '' },
    };
    const result = pruneMatchObject(match);
    expect(result).toEqual({
      channel: 'slack',
      peer: { kind: 'channel' },
    });
  });

  it('filters empty strings from arrays (roles)', () => {
    const match = {
      channel: 'discord',
      roles: ['admin', '', 'moderator', ''],
    };
    const result = pruneMatchObject(match);
    expect(result).toEqual({
      channel: 'discord',
      roles: ['admin', 'moderator'],
    });
  });

  it('drops arrays that become empty after filtering', () => {
    const match = {
      channel: 'discord',
      roles: ['', ''],
    };
    const result = pruneMatchObject(match);
    expect(result).toEqual({ channel: 'discord' });
  });

  it('returns empty object when all fields are empty', () => {
    const match = { channel: '', accountId: undefined };
    const result = pruneMatchObject(match);
    expect(result).toEqual({});
  });
});

describe('config-patcher: recomputeAgentToAgent', () => {
  it('enables A2A and adds namespace pattern for non-empty topology', () => {
    const config: Record<string, unknown> = {};
    const topology = {
      triage: ['knowledge', 'escalation'],
      knowledge: ['triage'],
    };

    const result = recomputeAgentToAgent(config, 'support', topology);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;

    expect(a2a.enabled).toBe(true);
    expect(a2a.allow).toContain('support-*');
  });

  it('sorts the allow list deterministically', () => {
    const config: Record<string, unknown> = {
      tools: {
        agentToAgent: {
          allow: ['zzz-*', 'aaa-*'],
          enabled: true,
        },
      },
    };
    const topology = { agent1: ['agent2'] };

    const result = recomputeAgentToAgent(config, 'mmm', topology);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;
    const allow = a2a.allow as string[];

    // Should be sorted
    const sorted = [...allow].sort();
    expect(allow).toEqual(sorted);
    expect(allow).toContain('mmm-*');
  });

  it('returns empty allow list and disables A2A for empty topology', () => {
    const config: Record<string, unknown> = {};
    const topology: Record<string, string[]> = {};

    const result = recomputeAgentToAgent(config, 'test-ns', topology);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;

    expect(a2a.enabled).toBe(false);
    expect(a2a.allow).toEqual([]);
  });

  it('returns empty allow list for undefined topology', () => {
    const config: Record<string, unknown> = {};

    const result = recomputeAgentToAgent(config, 'test-ns', undefined);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;

    expect(a2a.enabled).toBe(false);
    expect(a2a.allow).toEqual([]);
  });

  it('returns empty allow list for topology with only empty target arrays', () => {
    const config: Record<string, unknown> = {};
    const topology = { agent1: [], agent2: [] };

    const result = recomputeAgentToAgent(config, 'test-ns', topology);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;

    expect(a2a.enabled).toBe(false);
    expect(a2a.allow).toEqual([]);
  });

  it('preserves other namespace entries when removing own pattern', () => {
    const config: Record<string, unknown> = {
      tools: {
        agentToAgent: {
          allow: ['other-ns-*', 'test-ns-*'],
          enabled: true,
        },
      },
    };
    const topology: Record<string, string[]> = {};

    const result = recomputeAgentToAgent(config, 'test-ns', topology);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;

    // Own pattern removed, but other-ns-* preserved
    expect(a2a.allow).toEqual(['other-ns-*']);
    // Should NOT disable since other entries remain
    // (enabled stays as-is or remains true — the function only sets false when otherEntries is empty)
  });

  it('does not duplicate pattern when it already exists', () => {
    const config: Record<string, unknown> = {
      tools: {
        agentToAgent: {
          allow: ['support-*'],
          enabled: true,
        },
      },
    };
    const topology = { triage: ['knowledge'] };

    const result = recomputeAgentToAgent(config, 'support', topology);
    const a2a = (result.tools as Record<string, unknown>)
      .agentToAgent as Record<string, unknown>;
    const allow = a2a.allow as string[];

    // Should still have exactly one 'support-*' entry
    expect(allow.filter((p) => p === 'support-*')).toHaveLength(1);
  });
});
