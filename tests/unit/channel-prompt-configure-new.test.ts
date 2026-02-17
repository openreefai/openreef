import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelHint } from '../../src/core/variable-hints.js';
import type { Variable } from '../../src/types/manifest.js';

// Top-level mocks -- hoisted by vitest, isolated to this file.
// Mixing mocked and non-mocked child_process in the same test file
// causes flaky behavior, so configure-new tests live here.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: 'openclaw 0.5.0\n',
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  })),
}));

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

import { spawnSync } from 'node:child_process';
import { select, input, confirm } from '@inquirer/prompts';
import { promptChannel } from '../../src/core/channel-prompt.js';
import type { PromptContext } from '../../src/core/channel-prompt.js';

const baseHint: ChannelHint = {
  kind: 'channel',
  recentChannels: [
    { value: 'slack:#ops', label: 'slack:#ops (used by daily-ops)' },
  ],
  configuredTypes: [],
};

const baseConfig: Variable = {
  type: 'string',
  required: true,
  description: 'Primary contact channel',
};

// allowExternalCommands + isTTY = true so binary detection runs;
// the default spawnSync mock returns status 0 for --version,
// meaning configure-new WILL appear in the menu.
const ctxWithExternal: PromptContext = {
  allowExternalCommands: true,
  isTTY: true,
};

describe('promptChannel: configure-new action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: openclaw --version succeeds (binary found)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'openclaw 0.5.0\n',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });
  });

  it('shows configure-new when allowExternalCommands, isTTY, and openclaw found', async () => {
    vi.mocked(select).mockResolvedValueOnce('custom');
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, ctxWithExternal);

    const selectCall = vi.mocked(select).mock.calls[0][0] as { choices: unknown[] };
    const choiceValues = selectCall.choices
      .filter((c: unknown) => typeof c === 'object' && c !== null && 'value' in c)
      .map((c: unknown) => (c as { value: string }).value);
    expect(choiceValues).toContain('configure-new');
  });

  it('hides configure-new when openclaw binary not found', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    vi.mocked(select).mockResolvedValueOnce('custom');
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    await promptChannel('INTERACTION_CHANNEL', baseConfig, baseHint, ctxWithExternal);

    const selectCall = vi.mocked(select).mock.calls[0][0] as { choices: unknown[] };
    const choiceValues = selectCall.choices
      .filter((c: unknown) => typeof c === 'object' && c !== null && 'value' in c)
      .map((c: unknown) => (c as { value: string }).value);
    expect(choiceValues).not.toContain('configure-new');
  });

  it('returns to menu when user cancels confirm', async () => {
    vi.mocked(select)
      .mockResolvedValueOnce('configure-new')
      .mockResolvedValueOnce('custom');
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    const result = await promptChannel(
      'INTERACTION_CHANNEL',
      baseConfig,
      baseHint,
      ctxWithExternal,
    );

    expect(result).toBe('slack:#ops');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('returns to menu when openclaw channels add fails (non-zero exit)', async () => {
    // First call: --version succeeds (binary detection)
    // Second call: channels add fails
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 0,
        stdout: 'openclaw 0.5.0\n',
        stderr: '',
        pid: 1,
        output: [],
        signal: null,
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'error',
        pid: 1,
        output: [],
        signal: null,
      });

    vi.mocked(select)
      .mockResolvedValueOnce('configure-new')
      .mockResolvedValueOnce('custom');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    const result = await promptChannel(
      'INTERACTION_CHANNEL',
      baseConfig,
      baseHint,
      ctxWithExternal,
    );

    expect(result).toBe('slack:#ops');
  });

  it('calls reloadConfig after configure-new and renders refreshed types', async () => {
    const refreshedHint: ChannelHint = {
      kind: 'channel',
      recentChannels: baseHint.recentChannels,
      configuredTypes: ['telegram'],
    };
    const reloadConfig = vi.fn().mockResolvedValue(refreshedHint);

    // First render: user picks configure-new
    // Second render (after reload): user picks the newly-appeared telegram type
    vi.mocked(select)
      .mockResolvedValueOnce('configure-new')
      .mockResolvedValueOnce('type:telegram');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(input).mockResolvedValueOnce('#alerts');

    const result = await promptChannel(
      'INTERACTION_CHANNEL',
      baseConfig,
      baseHint,
      { ...ctxWithExternal, reloadConfig },
    );

    expect(reloadConfig).toHaveBeenCalledOnce();
    expect(result).toBe('telegram:#alerts');

    // Verify the second select call included the refreshed configured type
    const secondSelectCall = vi.mocked(select).mock.calls[1][0] as { choices: unknown[] };
    const choiceValues = secondSelectCall.choices
      .filter((c: unknown) => typeof c === 'object' && c !== null && 'value' in c)
      .map((c: unknown) => (c as { value: string }).value);
    expect(choiceValues).toContain('type:telegram');
  });

  it('returns to menu when openclaw command throws', async () => {
    // First call: --version succeeds (binary detection)
    // Second call: channels add throws
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 0,
        stdout: 'openclaw 0.5.0\n',
        stderr: '',
        pid: 1,
        output: [],
        signal: null,
      })
      .mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });

    vi.mocked(select)
      .mockResolvedValueOnce('configure-new')
      .mockResolvedValueOnce('custom');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(input).mockResolvedValueOnce('slack:#ops');

    const result = await promptChannel(
      'INTERACTION_CHANNEL',
      baseConfig,
      baseHint,
      ctxWithExternal,
    );

    expect(result).toBe('slack:#ops');
  });
});
