/**
 * Canonical tool names and normalization for OpenClaw.
 * Source: openclaw-audit/src/agents/tool-policy.ts
 */

/** All canonical tool names in OpenClaw */
export const CANONICAL_TOOLS = new Set([
  'read', 'write', 'edit', 'apply_patch',
  'exec', 'process',
  'web_search', 'web_fetch',
  'memory_search', 'memory_get',
  'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'session_status',
  'browser', 'canvas',
  'cron', 'gateway',
  'message', 'agents_list',
  'nodes',
  'image', 'tts',
]);

/** Known aliases that map to canonical names */
const ALIASES: Record<string, string> = {
  'bash': 'exec',
  'apply-patch': 'apply_patch',
  // Common formation misspellings
  'web-search': 'web_search',
  'web-fetch': 'web_fetch',
  'file-read': 'read',
  'file-write': 'write',
  'git-clone': 'exec',
  'shell': 'exec',
  'memory-search': 'memory_search',
  'memory-get': 'memory_get',
  'sessions-send': 'sessions_send',
  'sessions-list': 'sessions_list',
  'sessions-history': 'sessions_history',
  'sessions-spawn': 'sessions_spawn',
  'send_session': 'sessions_send',
  'session_send': 'sessions_send',
  'list_sessions': 'sessions_list',
  'session_list': 'sessions_list',
  'history_sessions': 'sessions_history',
  'session_history': 'sessions_history',
  'spawn_session': 'sessions_spawn',
  'session_spawn': 'sessions_spawn',
  'spawn-session': 'sessions_spawn',
  'session-status': 'session_status',
};

/** Tool groups matching OpenClaw's group: prefixed references */
export const TOOL_GROUPS: Record<string, string[]> = {
  'group:memory': ['memory_search', 'memory_get'],
  'group:web': ['web_search', 'web_fetch'],
  'group:fs': ['read', 'write', 'edit', 'apply_patch'],
  'group:runtime': ['exec', 'process'],
  'group:sessions': ['sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'session_status'],
  'group:ui': ['browser', 'canvas'],
  'group:automation': ['cron', 'gateway'],
  'group:messaging': ['message'],
  'group:nodes': ['nodes'],
};

/** Known channel tokens (built-in channels) */
export const KNOWN_CHANNELS = new Set([
  'slack', 'telegram', 'discord', 'whatsapp', 'teams',
]);

/**
 * Normalize a tool name: trim, lowercase, apply alias mapping.
 * Returns the canonical name or the input if no alias found.
 */
export function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return ALIASES[normalized] ?? normalized;
}

/**
 * Check if a name (after normalization) is a recognized canonical tool or group.
 */
export function isRecognizedTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return CANONICAL_TOOLS.has(normalized) || normalized in TOOL_GROUPS;
}

/**
 * If the raw name has a known alias, return the canonical name it maps to.
 * Returns undefined if no alias mapping exists.
 */
export function getAliasTarget(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return ALIASES[normalized];
}
