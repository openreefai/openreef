import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelHint } from '../../src/core/variable-hints.js';
import type { Variable } from '../../src/types/manifest.js';

// Mock @inquirer/prompts at module level (vitest hoists vi.mock)
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
  Separator: class MockSeparator {
    separator: string;
    type = 'separator';
    constructor(sep?: string) {
      this.separator = sep ?? '---';
    }
    static isSeparator(choice: unknown): boolean {
      return choice instanceof MockSeparator;
    }
  },
}));

import { select, input, confirm } from '@inquirer/prompts';
import { normalizeChannel, promptChannel } from '../../src/core/channel-prompt.js';
import type { PromptContext } from '../../src/core/channel-prompt.js';

describe('normalizeChannel', () => {
  it('normalizes valid type:scope', () => {
    expect(normalizeChannel('slack:#ops')).toBe('slack:#ops');
  });

  it('trims whitespace', () => {
    expect(normalizeChannel('  slack : #ops  ')).toBe('slack:#ops');
  });

  it('lowercases type', () => {
    expect(normalizeChannel('Slack:#ops')).toBe('slack:#ops');
  });

  it('returns null for bare channel (no colon)', () => {
    expect(normalizeChannel('slack')).toBeNull();
  });

  it('returns null for empty type', () => {
    expect(normalizeChannel(':#ops')).toBeNull();
  });

  it('returns null for empty scope', () => {
    expect(normalizeChannel('slack:')).toBeNull();
  });

  it('returns null for whitespace-only scope', () => {
    expect(normalizeChannel('slack:   ')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeChannel('')).toBeNull();
  });

  it('preserves scope case', () => {
    expect(normalizeChannel('slack:#MyChannel')).toBe('slack:#MyChannel');
  });
});

const baseHint: ChannelHint = {
  kind: 'channel',
  recentChannels: [
    { value: 'slack:#ops', label: 'slack:#ops (used by daily-ops)' },
    { value: 'telegram:12345', label: 'telegram:12345 (used by launch-ops)' },
  ],
  configuredTypes: ['discord'],
};

const baseConfig: Variable = {
  type: 'string',
  required: true,
  description: 'Primary contact channel',
};

const basePromptCtx: PromptContext = {
  allowExternalCommands: false,
  isTTY: true,
};

describe('promptChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns recent channel directly when selected', async () => {
    vi.mocked(select).mockResolvedValueOnce('recent:slack:#ops');

    const result = await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, basePromptCtx);
    expect(result).toBe('slack:#ops');
    expect(input).not.toHaveBeenCalled();
  });

  it('prompts for scope when configured type selected, composes type:scope', async () => {
    vi.mocked(select).mockResolvedValueOnce('type:discord');
    vi.mocked(input).mockResolvedValueOnce('#general');

    const result = await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, basePromptCtx);
    expect(result).toBe('discord:#general');
  });

  it('re-prompts on empty scope for configured type', async () => {
    vi.mocked(select).mockResolvedValueOnce('type:discord');
    vi.mocked(input)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('#ops');

    const result = await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, basePromptCtx);
    expect(result).toBe('discord:#ops');
    expect(input).toHaveBeenCalledTimes(2);
  });

  it('validates and normalizes custom input', async () => {
    vi.mocked(select).mockResolvedValueOnce('custom');
    vi.mocked(input).mockResolvedValueOnce('  Slack : #forge  ');

    const result = await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, basePromptCtx);
    expect(result).toBe('slack:#forge');
  });

  it('re-prompts on invalid custom input (no colon)', async () => {
    vi.mocked(select).mockResolvedValueOnce('custom');
    vi.mocked(input)
      .mockResolvedValueOnce('slack')
      .mockResolvedValueOnce('slack:#ops');

    const result = await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, basePromptCtx);
    expect(result).toBe('slack:#ops');
    expect(input).toHaveBeenCalledTimes(2);
  });

  it('does not show configure-new when allowExternalCommands is false', async () => {
    vi.mocked(select).mockResolvedValueOnce('custom');
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, basePromptCtx);

    const selectCall = vi.mocked(select).mock.calls[0][0] as { choices: unknown[] };
    const choiceValues = selectCall.choices
      .filter((c: unknown) => typeof c === 'object' && c !== null && 'value' in c)
      .map((c: unknown) => (c as { value: string }).value);
    expect(choiceValues).not.toContain('configure-new');
  });

  it('shows only custom when hint has no recent channels and no configured types', async () => {
    const emptyHint: ChannelHint = {
      kind: 'channel',
      recentChannels: [],
      configuredTypes: [],
    };
    vi.mocked(select).mockResolvedValueOnce('custom');
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    const result = await promptChannel(
      'INTERACTION_CHANNEL',
      baseConfig,
      emptyHint,
      basePromptCtx,
    );
    expect(result).toBe('slack:#ops');
  });
});
