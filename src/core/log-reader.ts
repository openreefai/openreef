import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveStateDir } from './openclaw-paths.js';

export interface LogEntry {
  timestamp?: string;
  agentId: string;
  file: string;
  line: string;
}

export interface LogDiscoveryResult {
  agentId: string;
  sessionDir: string;
  logFiles: string[];
}

/**
 * Discover log files (session transcripts) for an agent.
 * OpenClaw stores sessions at $STATE_DIR/agents/{agentId}/sessions/*.jsonl
 */
export async function discoverLogs(
  agentId: string,
  env?: NodeJS.ProcessEnv,
): Promise<LogDiscoveryResult | null> {
  const stateDir = resolveStateDir(env);
  const sessionDir = join(stateDir, 'agents', agentId, 'sessions');

  if (!existsSync(sessionDir)) return null;

  try {
    const entries = await readdir(sessionDir);
    const logFiles = entries
      .filter((e) => e.endsWith('.jsonl'))
      .sort();
    return { agentId, sessionDir, logFiles };
  } catch {
    return null;
  }
}

/**
 * Read the last N lines from a log file.
 */
export async function readLogTail(
  filePath: string,
  lines: number,
): Promise<string[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const allLines = content.split('\n').filter((l) => l.trim().length > 0);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Read logs for an agent, returning the most recent entries.
 */
export async function readAgentLogs(
  agentId: string,
  options: { lines?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<LogEntry[]> {
  const maxLines = options.lines ?? 50;
  const discovery = await discoverLogs(agentId, options.env);

  if (!discovery || discovery.logFiles.length === 0) return [];

  const entries: LogEntry[] = [];

  // Read from most recent files first
  const sortedFiles = [...discovery.logFiles].reverse();
  for (const file of sortedFiles) {
    if (entries.length >= maxLines) break;

    const filePath = join(discovery.sessionDir, file);
    const remaining = maxLines - entries.length;
    const lines = await readLogTail(filePath, remaining);

    for (const line of lines) {
      let timestamp: string | undefined;
      try {
        const parsed = JSON.parse(line);
        timestamp = parsed.ts ?? parsed.timestamp ?? parsed.createdAt;
      } catch {
        // Not valid JSON — use raw line
      }
      entries.push({ timestamp, agentId, file, line });
    }
  }

  return entries.reverse();
}
