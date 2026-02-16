import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import { resolveConfigPath, resolveStateDir, resolveWorkspacePath } from './openclaw-paths.js';
import type { OpenClawBinding } from '../types/state.js';
import type { Binding } from '../types/manifest.js';

export interface AgentEntry {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  skills?: string[];
  identity?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  tools?: Record<string, unknown>;
}

export interface ConfigData {
  config: Record<string, unknown>;
  raw: string;
  path: string;
}

export async function readConfig(
  configPath?: string,
  env?: NodeJS.ProcessEnv,
): Promise<ConfigData> {
  const path = configPath ?? resolveConfigPath(env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    // Config doesn't exist yet — start with empty
    return { config: { agents: { list: [] }, bindings: [] }, raw: '', path };
  }

  // Warn about $include and ${VAR} references
  if (raw.includes('$include') || /\$\{[^}]+\}/.test(raw)) {
    console.warn(
      'Config uses $include or ${VAR}. OpenReef patches raw config, which may differ from effective runtime config. Proceeding.',
    );
  }

  const config = JSON5.parse(raw);
  return { config, raw, path };
}

export async function writeConfig(
  configPath: string,
  config: Record<string, unknown>,
  options?: { silent?: boolean },
): Promise<void> {
  const tmpPath = configPath + '.tmp';
  const bakPath = configPath + '.bak';
  const json = JSON.stringify(config, null, 2) + '\n';

  await writeFile(tmpPath, json, 'utf-8');

  // Backup original if exists
  if (existsSync(configPath)) {
    const existing = await readFile(configPath, 'utf-8');
    let isAlreadyJson = false;
    try {
      JSON.parse(existing);
      isAlreadyJson = true;
    } catch {
      // Not valid JSON — was JSON5 with comments/trailing commas
    }

    await rename(configPath, bakPath);
    if (!options?.silent && !isAlreadyJson) {
      console.log(
        `Config rewritten as JSON — comments from original JSON5 removed. Backup: ${bakPath}`,
      );
    }
  }

  await rename(tmpPath, configPath);
}

function ensureAgentsList(
  config: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!config.agents) config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!Array.isArray(agents.list)) agents.list = [];
  return agents.list as Record<string, unknown>[];
}

function ensureBindings(config: Record<string, unknown>): unknown[] {
  if (!Array.isArray(config.bindings)) config.bindings = [];
  return config.bindings as unknown[];
}

export function addAgentEntry(
  config: Record<string, unknown>,
  agent: AgentEntry,
  env?: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const list = ensureAgentsList(config);
  const normalizedId = agent.id.trim().toLowerCase();

  // Idempotent: skip if agent with same id exists (normalized comparison)
  if (list.some((a) => String((a as Record<string, unknown>).id).trim().toLowerCase() === normalizedId)) {
    return config;
  }

  // Seed main when transitioning from empty to populated list.
  // Main uses "workspace" (no suffix), not "workspace-main".
  if (list.length === 0 && normalizedId !== 'main') {
    list.unshift({
      id: 'main',
      default: true,
      workspace: join(resolveStateDir(env), 'workspace'),
    });
  }

  const entry: Record<string, unknown> = {
    id: agent.id,
  };
  if (agent.name) entry.name = agent.name;
  entry.workspace = agent.workspace ?? resolveWorkspacePath(agent.id, env);
  if (agent.model) entry.model = agent.model;
  if (agent.skills) entry.skills = agent.skills;
  if (agent.identity) entry.identity = agent.identity;
  if (agent.sandbox) entry.sandbox = agent.sandbox;
  if (agent.tools) entry.tools = agent.tools;

  list.push(entry);
  return config;
}

export function removeAgentEntry(
  config: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> {
  const agents = config.agents as Record<string, unknown> | undefined;
  if (!agents || !Array.isArray(agents.list)) return config;
  agents.list = (agents.list as Record<string, unknown>[]).filter(
    (a) => a.id !== agentId,
  );
  return config;
}

export function addBinding(
  config: Record<string, unknown>,
  binding: OpenClawBinding,
): Record<string, unknown> {
  const bindings = ensureBindings(config);
  if (
    bindings.some((b) => bindingsEqual(b as OpenClawBinding, binding))
  ) {
    return config;
  }
  bindings.push(binding);
  return config;
}

export function removeBinding(
  config: Record<string, unknown>,
  binding: OpenClawBinding,
): Record<string, unknown> {
  if (!Array.isArray(config.bindings)) return config;
  config.bindings = (config.bindings as OpenClawBinding[]).filter(
    (b) => !bindingsEqual(b, binding),
  );
  return config;
}

export function setAgentToAgent(
  config: Record<string, unknown>,
  namespace: string,
): Record<string, unknown> {
  if (!config.tools) config.tools = {};
  const tools = config.tools as Record<string, unknown>;
  if (!tools.agentToAgent) tools.agentToAgent = {};
  const a2a = tools.agentToAgent as Record<string, unknown>;

  a2a.enabled = true;

  if (!Array.isArray(a2a.allow)) a2a.allow = [];
  const allow = a2a.allow as string[];
  const pattern = `${namespace}-*`;
  if (!allow.includes(pattern)) {
    allow.push(pattern);
  }

  return config;
}

export function removeAgentToAgent(
  config: Record<string, unknown>,
  namespace: string,
  otherFormationsInNamespace: boolean,
  wasEnabled?: boolean,
): Record<string, unknown> {
  const tools = config.tools as Record<string, unknown> | undefined;
  if (!tools?.agentToAgent) return config;
  const a2a = tools.agentToAgent as Record<string, unknown>;

  if (!otherFormationsInNamespace) {
    const pattern = `${namespace}-*`;
    if (Array.isArray(a2a.allow)) {
      a2a.allow = (a2a.allow as string[]).filter((p) => p !== pattern);
    }
  }

  // Only disable if we originally enabled it
  if (wasEnabled === false && !otherFormationsInNamespace) {
    a2a.enabled = false;
  }

  return config;
}

export function bindingsEqual(a: OpenClawBinding, b: OpenClawBinding): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        JSON.stringify(k) +
        ':' +
        canonicalJson((obj as Record<string, unknown>)[k]),
    );
  return '{' + sorted.join(',') + '}';
}

// ─── Channel detection utilities ─────────────────────────────────

/**
 * Returns true when the channel string has no `:scope` suffix.
 * Bare channels like "telegram" shadow the main agent because they route
 * ALL messages on that channel to the formation agent.
 */
export function isBareChannel(channel: string): boolean {
  return !channel.trim().includes(':');
}

export interface ClassifiedBinding {
  binding: Binding;
  channelType: string;
  status: 'configured' | 'unconfigured' | 'unknown';
  isBare: boolean;
}

/**
 * Parses "slack:#support" → "slack", "telegram" → "telegram".
 * Splits on first `:` and normalizes with trim + lowercase.
 */
export function extractChannelType(channel: string): string {
  const idx = channel.indexOf(':');
  const raw = idx === -1 ? channel : channel.slice(0, idx);
  return raw.trim().toLowerCase();
}

/**
 * Reads config.channels and returns the set of channel types where enabled !== false.
 * Returns null when config.channels is absent or non-object (unknown — wire everything).
 * Skips the "defaults" key since it's not a channel.
 */
export function getConfiguredChannels(
  config: Record<string, unknown>,
): Set<string> | null {
  const channels = config.channels;
  if (channels === undefined || channels === null) return null;
  if (typeof channels !== 'object' || Array.isArray(channels)) return null;

  const result = new Set<string>();
  for (const [key, value] of Object.entries(channels as Record<string, unknown>)) {
    if (key.trim().toLowerCase() === 'defaults') continue;
    const normalizedKey = key.trim().toLowerCase();
    // Non-object entry (e.g. channels.slack = true) — treat as configured
    if (typeof value !== 'object' || value === null) {
      result.add(normalizedKey);
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (entry.enabled !== false) {
      result.add(normalizedKey);
    }
  }
  return result;
}

/**
 * Maps each binding to { binding, channelType, status }.
 * When configuredChannels is null, all bindings get status 'unknown'.
 */
export function classifyBindings(
  bindings: Binding[],
  configuredChannels: Set<string> | null,
): ClassifiedBinding[] {
  return bindings.map((binding) => {
    const channelType = extractChannelType(binding.channel);
    let status: ClassifiedBinding['status'];
    if (configuredChannels === null) {
      status = 'unknown';
    } else if (configuredChannels.has(channelType)) {
      status = 'configured';
    } else {
      status = 'unconfigured';
    }
    return { binding, channelType, status, isBare: isBareChannel(binding.channel) };
  });
}

/**
 * Returns the filtered binding list: keeps 'configured' and 'unknown', drops 'unconfigured'.
 * Also drops bare-channel bindings unless allowChannelShadow is set.
 * Used in --yes fresh/force installs and as the default selection for the interactive checkbox.
 */
export function resolveSelectedBindings(
  classifiedBindings: ClassifiedBinding[],
  options?: { allowChannelShadow?: boolean },
): Binding[] {
  return classifiedBindings
    .filter((cb) => cb.status !== 'unconfigured')
    .filter((cb) => !cb.isBare || options?.allowChannelShadow)
    .map((cb) => cb.binding);
}
