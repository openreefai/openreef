import { spawnSync } from 'node:child_process';
import type { Variable } from '../types/manifest.js';
import { listStates } from './state-manager.js';
import {
  readConfig,
  getConfiguredChannels,
  extractChannelType,
} from './config-patcher.js';

// ── Types ──

export interface VariableHintContext {
  env: NodeJS.ProcessEnv;
}

export interface ChannelHint {
  kind: 'channel';
  recentChannels: Array<{ value: string; label: string }>;
  configuredTypes: string[];
}

export interface PrefillHint {
  kind: 'prefill';
  defaultValue: string;
  source: string;
}

export type VariableHint = ChannelHint | PrefillHint;

// ── Detection ──

const CHANNEL_SUFFIX = /_CHANNEL$/;
const GH_LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const MAX_RECENT_CHANNELS = 5;

/**
 * Generate a hint for a variable based on name convention.
 * Read-only data access (filesystem, config, state). No mutation.
 * GitHub prefill performs a best-effort read-only `gh` probe (spawnSync).
 */
export async function getVariableHint(
  name: string,
  config: Variable,
  context: VariableHintContext,
): Promise<VariableHint | null> {
  if (config.type !== 'string') return null;

  if (CHANNEL_SUFFIX.test(name)) {
    return buildChannelHint(context);
  }

  if (name === 'GITHUB_USERNAME') {
    return buildGitHubHint(context);
  }

  return null;
}

// ── Channel hint ──

async function buildChannelHint(
  context: VariableHintContext,
): Promise<ChannelHint> {
  const states = await listStates(context.env);
  const recentChannels = buildRecentChannels(states);

  const { config } = await readConfig(undefined, context.env);
  const configuredSet = getConfiguredChannels(config);
  const recentTypes = new Set(
    recentChannels.map((c) => extractChannelType(c.value)),
  );
  const configuredTypes = filterConfiguredTypes(configuredSet, recentTypes);

  return { kind: 'channel', recentChannels, configuredTypes };
}

interface RecentChannel {
  value: string;
  label: string;
}

function buildRecentChannels(
  states: Array<{
    name: string;
    installedAt: string;
    bindings: Array<{ match: { channel: string } }>;
  }>,
): RecentChannel[] {
  const sorted = [...states].sort((a, b) =>
    (b.installedAt ?? '').localeCompare(a.installedAt ?? ''),
  );

  const seen = new Set<string>();
  const result: RecentChannel[] = [];

  for (const state of sorted) {
    for (const binding of state.bindings ?? []) {
      const channel = binding.match?.channel;
      if (!channel) continue;
      if (!channel.includes(':')) continue;

      const normalized = channel.trim().toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      result.push({
        value: channel,
        label: `${channel} (used by ${state.name})`,
      });

      if (result.length >= MAX_RECENT_CHANNELS) return result;
    }
  }

  return result;
}

function filterConfiguredTypes(
  configuredSet: Set<string> | null,
  recentTypes: Set<string>,
): string[] {
  if (!configuredSet) return [];
  return [...configuredSet].filter((type) => !recentTypes.has(type));
}

// ── GitHub hint (best-effort read-only probe) ──

/**
 * Attempt to detect GitHub login via `gh api user`.
 * Exported for testability -- dedicated test file mocks child_process
 * at the module level and tests this function directly.
 */
export function probeGitHubLogin(env: NodeJS.ProcessEnv): string | null {
  try {
    const result = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      env,
    });
    if (result.status === 0 && result.stdout) {
      const login = result.stdout.trim();
      if (GH_LOGIN_RE.test(login)) {
        return login;
      }
    }
  } catch {
    // gh not installed, not authed, timeout -- silent fallback
  }
  return null;
}

function buildGitHubHint(context: VariableHintContext): PrefillHint | null {
  const login = probeGitHubLogin(context.env);
  if (login) {
    return { kind: 'prefill', defaultValue: login, source: 'GitHub CLI' };
  }
  return null;
}
