import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { networkInterfaces } from 'node:os';

const CONFIG_FILENAMES = [
  'openclaw.json',
  'clawdbot.json',
  'moldbot.json',
  'moltbot.json',
];

const LEGACY_DIRS = ['.clawdbot', '.moldbot', '.moltbot'];

export function resolveHomeDir(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const raw = e.OPENCLAW_HOME ?? e.HOME ?? e.USERPROFILE;
  if (raw) {
    if (raw.startsWith('~')) {
      return join(os.homedir(), raw.slice(1));
    }
    return raw;
  }
  return os.homedir();
}

export function resolveStateDir(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const explicit = e.OPENCLAW_STATE_DIR ?? e.CLAWDBOT_STATE_DIR;
  if (explicit) return explicit;

  const homeDir = resolveHomeDir(env);
  const primary = join(homeDir, '.openclaw');
  if (existsSync(primary)) return primary;

  for (const legacy of LEGACY_DIRS) {
    const candidate = join(homeDir, legacy);
    if (existsSync(candidate)) return candidate;
  }

  return primary;
}

export function resolveConfigPath(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;

  // 1. Explicit config path env
  const explicitPath = e.OPENCLAW_CONFIG_PATH ?? e.CLAWDBOT_CONFIG_PATH;
  if (explicitPath) return explicitPath;

  const stateDir = resolveStateDir(env);

  // 2. Search state dir for first existing config file
  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(stateDir, filename);
    if (existsSync(candidate)) return candidate;
  }

  // 3. If OPENCLAW_STATE_DIR was explicitly set, return canonical path (skip home search)
  const hasExplicitStateDir = !!(e.OPENCLAW_STATE_DIR ?? e.CLAWDBOT_STATE_DIR);
  if (hasExplicitStateDir) {
    return join(stateDir, 'openclaw.json');
  }

  // 4. Only for default state dir: search across all home directories
  const homeDir = resolveHomeDir(env);
  const homeDirs = [
    join(homeDir, '.openclaw'),
    join(homeDir, '.clawdbot'),
    join(homeDir, '.moldbot'),
    join(homeDir, '.moltbot'),
  ];
  for (const dir of homeDirs) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
  }

  // 5. Ultimate fallback
  return join(stateDir, 'openclaw.json');
}

export function resolveWorkspacePath(
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return join(resolveStateDir(env), `workspace-${agentId}`);
}

export function resolveReefStateDir(env?: NodeJS.ProcessEnv): string {
  return join(resolveStateDir(env), '.reef');
}

export function resolveGatewayUrl(
  config?: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): string {
  const e = env ?? process.env;
  const gw = (config?.gateway ?? {}) as Record<string, unknown>;
  const tls = (gw.tls ?? {}) as Record<string, unknown>;
  const bind = (gw.bind as string) ?? 'loopback';

  const envPort = e.OPENCLAW_GATEWAY_PORT
    ? parseInt(e.OPENCLAW_GATEWAY_PORT, 10)
    : null;
  const port =
    (gw.port as number) ??
    (envPort !== null && !isNaN(envPort) ? envPort : null) ??
    18789;

  const scheme = tls.enabled ? 'wss' : 'ws';

  if (bind === 'tailnet') {
    const ip = findIPv4('tailscale');
    // Tailnet uses scheme from TLS config, not hardcoded wss
    if (ip) return `${scheme}://${ip}:${port}`;
  }

  if (bind === 'lan') {
    const ip = findLanIPv4();
    if (ip) return `${scheme}://${ip}:${port}`;
  }

  return `${scheme}://127.0.0.1:${port}`;
}

function findIPv4(interfacePrefix: string): string | null {
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!name.toLowerCase().startsWith(interfacePrefix)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function findLanIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateAgentId(id: string): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  const normalized = id.toLowerCase();

  if (normalized.includes('.')) {
    return {
      valid: false,
      normalized,
      error: `Agent ID "${id}" contains dots — OpenClaw collapses dots to dashes. Use dashes instead.`,
    };
  }

  if (normalized.length > 64) {
    return {
      valid: false,
      normalized,
      error: `Agent ID "${id}" exceeds 64 characters (${normalized.length}).`,
    };
  }

  if (!AGENT_ID_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: `Agent ID "${id}" does not match [a-z0-9][a-z0-9_-]{0,63}.`,
    };
  }

  return { valid: true, normalized };
}

export function validateAgentIds(
  slugs: string[],
  namespace: string,
): { valid: boolean; ids: Map<string, string>; errors: string[] } {
  const ids = new Map<string, string>();
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const slug of slugs) {
    const id = `${namespace}-${slug}`;
    const result = validateAgentId(id);

    if (!result.valid) {
      errors.push(result.error!);
      continue;
    }

    const existing = seen.get(result.normalized);
    if (existing) {
      errors.push(
        `Slugs "${existing}" and "${slug}" produce the same normalized ID "${result.normalized}".`,
      );
      continue;
    }

    seen.set(result.normalized, slug);
    ids.set(slug, result.normalized);
  }

  return { valid: errors.length === 0, ids, errors };
}
