import { spawnSync } from 'node:child_process';
import type { ChannelHint } from './variable-hints.js';
import type { Variable } from '../types/manifest.js';

/**
 * Normalize a channel string to `type:scope` form.
 * Returns null if the input is invalid (missing type, missing scope, etc.).
 */
export function normalizeChannel(raw: string): string | null {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) return null;

  const type = trimmed.slice(0, colonIdx).trim().toLowerCase();
  const scope = trimmed.slice(colonIdx + 1).trim();

  if (type.length === 0 || scope.length === 0) return null;

  return `${type}:${scope}`;
}

// ── Prompt types ──

export interface PromptContext {
  allowExternalCommands: boolean;
  isTTY: boolean;
  reloadConfig?: () => Promise<ChannelHint>;
}

// ── Interactive channel prompt ──

/**
 * Interactive channel selection prompt.
 * Returns a normalized `type:scope` string.
 */
export async function promptChannel(
  name: string,
  config: Variable,
  hint: ChannelHint,
  promptCtx: PromptContext,
): Promise<string> {
  const { select, input, confirm, Separator } = await import('@inquirer/prompts');

  // Binary discovery at render time (design principle: not in hint layer)
  let canConfigureNew = false;
  if (promptCtx.allowExternalCommands && promptCtx.isTTY) {
    try {
      const result = spawnSync('openclaw', ['--version'], {
        timeout: 2000,
        stdio: 'ignore',
      });
      canConfigureNew = result.status === 0;
    } catch {
      // openclaw not on PATH -- that's fine
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const choices: Array<InstanceType<typeof Separator> | { name: string; value: string }> = [];

    // Section 1: Recent channels
    if (hint.recentChannels.length > 0) {
      choices.push(new Separator('── Recent channels ──'));
      for (const rc of hint.recentChannels) {
        choices.push({ name: rc.label, value: `recent:${rc.value}` });
      }
    }

    // Section 2: Configured types
    if (hint.configuredTypes.length > 0) {
      choices.push(new Separator('── Configured channels ──'));
      for (const channelType of hint.configuredTypes) {
        const displayName = channelType.charAt(0).toUpperCase() + channelType.slice(1);
        choices.push({
          name: `${displayName} → enter scope`,
          value: `type:${channelType}`,
        });
      }
    }

    // Section 3: Other actions
    choices.push(new Separator('── Other ──'));

    if (canConfigureNew) {
      choices.push({
        name: 'Configure a new channel provider',
        value: 'configure-new',
      });
    }

    choices.push({
      name: 'Enter custom type:scope',
      value: 'custom',
    });

    const description = config.description ? ` (${config.description})` : '';
    const selection = await select({
      message: `${name}${description}:`,
      choices,
    });

    // Handle selection
    if (typeof selection === 'string' && selection.startsWith('recent:')) {
      return selection.slice('recent:'.length);
    }

    if (typeof selection === 'string' && selection.startsWith('type:')) {
      const channelType = selection.slice('type:'.length);
      const scope = await promptScope(input, channelType);
      if (scope !== null) {
        return `${channelType}:${scope}`;
      }
      continue;
    }

    if (selection === 'configure-new') {
      await handleConfigureNew(confirm);
      if (promptCtx.reloadConfig) {
        hint = await promptCtx.reloadConfig();
      }
      continue;
    }

    if (selection === 'custom') {
      const channel = await promptCustomChannel(input);
      if (channel !== null) {
        return channel;
      }
      continue;
    }
  }
}

// ── Internal helpers ──

const MAX_RETRIES = 3;

async function promptScope(
  inputFn: (opts: { message: string }) => Promise<string>,
  channelType: string,
): Promise<string | null> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const raw = await inputFn({
      message: `Scope for ${channelType} (e.g., #channel, @user, group-id):`,
    });
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
    console.log('  Scope cannot be empty. Please try again.');
  }
  return null;
}

async function promptCustomChannel(
  inputFn: (opts: { message: string }) => Promise<string>,
): Promise<string | null> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const raw = await inputFn({
      message: 'Channel (type:scope):',
    });
    const normalized = normalizeChannel(raw);
    if (normalized !== null) return normalized;
    console.log('  Invalid format. Use type:scope (e.g., slack:#ops, telegram:12345).');
  }
  return null;
}

async function handleConfigureNew(
  confirmFn: (opts: { message: string }) => Promise<boolean>,
): Promise<void> {
  const proceed = await confirmFn({
    message: 'This will run openclaw channels add. Proceed?',
  });
  if (!proceed) return;

  try {
    const result = spawnSync('openclaw', ['channels', 'add'], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.log('  Warning: openclaw channels add exited with non-zero status. Returning to menu.');
    }
  } catch {
    console.log('  Warning: Failed to run openclaw channels add. Returning to menu.');
  }
}
