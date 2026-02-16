import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat as fsStat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { discoverLogs, readAgentLogs, readLogTail } from '../core/log-reader.js';
import { resolveStateDir } from '../core/openclaw-paths.js';
import { icons, header, label, value } from '../utils/output.js';
import {
  resolveFormationState,
  FormationNotFoundError,
  AmbiguousFormationError,
} from '../utils/identifiers.js';
import type { FormationState } from '../types/state.js';

export interface LogsOptions {
  agent?: string;
  lines?: number;
  follow?: boolean;
  path?: string;
}

const AGENT_COLORS = [
  chalk.cyan,
  chalk.magenta,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.red,
];

export async function logs(
  identifier: string,
  options: LogsOptions,
): Promise<void> {
  // If --path is provided, read from that path directly
  if (options.path) {
    if (!existsSync(options.path)) {
      console.error(`${icons.error} Log file not found: ${options.path}`);
      process.exit(1);
    }
    const lines = await readLogTail(options.path, options.lines ?? 50);
    for (const line of lines) {
      console.log(line);
    }

    if (options.follow) {
      await tailFollow(options.path);
    }
    return;
  }

  // Resolve formation
  let state: FormationState;
  try {
    state = await resolveFormationState(identifier);
  } catch (err) {
    if (err instanceof FormationNotFoundError) {
      console.error(`${icons.error} ${err.message}`);
      process.exit(1);
    }
    if (err instanceof AmbiguousFormationError) {
      console.error(
        `${icons.error} Multiple formations named "${err.message.split('"')[1]}" found:`,
      );
      for (const m of err.matches) {
        console.error(`  - ${m.namespace}/${m.name}`);
      }
      console.error('  Specify the full namespace/name.');
      process.exit(1);
    }
    throw err;
  }

  // Filter agents
  const agents = options.agent
    ? Object.values(state.agents).filter(
        (a) => a.slug === options.agent || a.id === options.agent,
      )
    : Object.values(state.agents);

  if (agents.length === 0) {
    console.error(
      `${icons.error} No agent found matching "${options.agent}" in formation.`,
    );
    process.exit(1);
  }

  let hasLogs = false;

  for (const agent of agents) {
    const entries = await readAgentLogs(agent.id, {
      lines: options.lines ?? 50,
    });

    if (entries.length === 0) continue;
    hasLogs = true;

    if (agents.length > 1) {
      console.log('');
      console.log(header(`Agent: ${agent.slug} (${agent.id})`));
    }

    for (const entry of entries) {
      const ts = entry.timestamp
        ? chalk.dim(`[${entry.timestamp}] `)
        : '';
      console.log(`${ts}${entry.line}`);
    }
  }

  if (!hasLogs) {
    console.log(
      `${icons.info} No logs found for formation "${state.namespace}/${state.name}".`,
    );
    console.log(
      '  Session logs are stored at $STATE_DIR/agents/{agentId}/sessions/*.jsonl',
    );
    console.log(
      '  Use --path to read from a specific log file.',
    );
  }

  // Follow mode
  if (options.follow) {
    if (agents.length === 1) {
      const discovery = await discoverLogs(agents[0].id);
      if (discovery && discovery.logFiles.length > 0) {
        const latestFile = join(
          discovery.sessionDir,
          discovery.logFiles[discovery.logFiles.length - 1],
        );
        await tailFollow(latestFile);
      } else {
        // Wait mode for single agent
        await tailFollowMulti(agents.map((a) => ({ id: a.id, slug: a.slug })));
      }
    } else if (agents.length > 1) {
      await tailFollowMulti(agents.map((a) => ({ id: a.id, slug: a.slug })));
    }
  }
}

async function tailFollow(filePath: string): Promise<void> {
  console.log(chalk.dim('\n--- Following (Ctrl+C to stop) ---\n'));

  let stopped = false;
  let lastSize = 0;
  try {
    const s = await fsStat(filePath);
    lastSize = s.size;
  } catch {
    // File may not exist yet
  }

  const watcher = watch(filePath, async () => {
    if (stopped) return;
    try {
      const content = await readFile(filePath, 'utf-8');
      const newContent = content.slice(lastSize);
      lastSize = content.length;
      if (newContent.trim()) {
        process.stdout.write(newContent);
      }
    } catch {
      // File may have been deleted
    }
  });
  watcher.on('error', () => {});

  // Keep process alive until Ctrl+C
  await new Promise<void>((resolve) => {
    const onSigint = (): void => {
      stopped = true;
      watcher.close();
      process.off('SIGINT', onSigint);
      resolve();
    };
    process.on('SIGINT', onSigint);
  });
}

async function tailFollowMulti(
  agents: { id: string; slug: string }[],
): Promise<void> {
  console.log(chalk.dim('\n--- Following (Ctrl+C to stop) ---\n'));

  let stopped = false;
  const stateDir = resolveStateDir();
  const watchers: FSWatcher[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Per-agent tracking
  const agentState = new Map<
    string,
    {
      slug: string;
      color: (s: string) => string;
      sessionDir: string;
      currentFile: string | null;
      lastSize: number;
      dirWatcher: FSWatcher | null;
      fileWatcher: FSWatcher | null;
      rescanInterval: ReturnType<typeof setInterval> | null;
      debounceTimer: ReturnType<typeof setTimeout> | null;
    }
  >();

  function cleanup(): void {
    if (stopped) return;
    stopped = true;

    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    for (const interval of intervals) {
      clearInterval(interval);
    }
    for (const [, state] of agentState) {
      if (state.dirWatcher) {
        try { state.dirWatcher.close(); } catch { /* ignore */ }
      }
      if (state.fileWatcher) {
        try { state.fileWatcher.close(); } catch { /* ignore */ }
      }
      if (state.rescanInterval) {
        clearInterval(state.rescanInterval);
      }
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
    }
  }

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const color = AGENT_COLORS[i % AGENT_COLORS.length];
    const prefix = color(`[${agent.slug}]`);
    const sessionDir = join(stateDir, 'agents', agent.id, 'sessions');

    const state = {
      slug: agent.slug,
      color,
      sessionDir,
      currentFile: null as string | null,
      lastSize: 0,
      dirWatcher: null as FSWatcher | null,
      fileWatcher: null as FSWatcher | null,
      rescanInterval: null as ReturnType<typeof setInterval> | null,
      debounceTimer: null as ReturnType<typeof setTimeout> | null,
    };
    agentState.set(agent.id, state);

    async function readNewContent(): Promise<void> {
      if (stopped) return;
      if (!state.currentFile) return;
      try {
        const content = await readFile(state.currentFile, 'utf-8');
        const newContent = content.slice(state.lastSize);
        state.lastSize = content.length;
        if (newContent.trim()) {
          for (const line of newContent.split('\n')) {
            if (line.trim()) {
              process.stdout.write(`${prefix} ${line}\n`);
            }
          }
        }
      } catch {
        // File may have been deleted
      }
    }

    function debouncedRead(): void {
      if (stopped) return;
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        if (stopped) return;
        readNewContent();
      }, 100);
    }

    async function getNewestFile(): Promise<string | null> {
      if (stopped) return null;
      try {
        const entries = await readdir(sessionDir);
        const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl')).sort();
        return jsonlFiles.length > 0
          ? join(sessionDir, jsonlFiles[jsonlFiles.length - 1])
          : null;
      } catch {
        return null;
      }
    }

    function watchFile(filePath: string): void {
      if (stopped) return;
      // Close old file watcher
      if (state.fileWatcher) {
        try { state.fileWatcher.close(); } catch { /* ignore */ }
        const idx = watchers.indexOf(state.fileWatcher);
        if (idx !== -1) watchers.splice(idx, 1);
      }

      state.currentFile = filePath;
      state.lastSize = 0;

      // Get current size to only tail new content
      fsStat(filePath).then((s) => {
        if (stopped) return;
        state.lastSize = s.size;
      }).catch(() => {});

      try {
        state.fileWatcher = watch(filePath, () => {
          if (stopped) return;
          debouncedRead();
        });
        state.fileWatcher.on('error', () => {});
        watchers.push(state.fileWatcher);
      } catch {
        // Ignore watch setup failures (e.g. transient EMFILE)
      }
    }

    async function retargetIfNeeded(): Promise<void> {
      if (stopped) return;
      const newest = await getNewestFile();
      if (newest && newest !== state.currentFile) {
        watchFile(newest);
      }
    }

    function watchSessionDir(): void {
      if (stopped) return;
      if (!existsSync(sessionDir)) return;

      // Close old dir watcher
      if (state.dirWatcher) {
        try { state.dirWatcher.close(); } catch { /* ignore */ }
        const idx = watchers.indexOf(state.dirWatcher);
        if (idx !== -1) watchers.splice(idx, 1);
      }

      try {
        state.dirWatcher = watch(sessionDir, () => {
          if (stopped) return;
          retargetIfNeeded();
        });
        state.dirWatcher.on('error', () => {});
        watchers.push(state.dirWatcher);
      } catch {
        // Ignore watch setup failures (e.g. transient EMFILE)
      }

      // Periodic re-scan fallback (2s) for platform reliability
      if (state.rescanInterval) clearInterval(state.rescanInterval);
      state.rescanInterval = setInterval(() => {
        if (stopped) return;
        retargetIfNeeded();
      }, 2000);
      intervals.push(state.rescanInterval);
    }

    // Initialize: check if session dir exists and has files
    if (existsSync(sessionDir)) {
      const newest = await getNewestFile();
      if (newest) {
        watchFile(newest);
      }
      watchSessionDir();
    } else {
      // Wait mode: poll for session dir to appear
      // Avoid fs.watch({ recursive: true }) which is not portable (throws on Linux)
      process.stdout.write(`${prefix} ${chalk.dim('Waiting for sessions...')}\n`);

      const waitInterval = setInterval(async () => {
        if (stopped) return;
        if (existsSync(sessionDir)) {
          clearInterval(waitInterval);
          const waitIdx = intervals.indexOf(waitInterval);
          if (waitIdx !== -1) intervals.splice(waitIdx, 1);

          const newest = await getNewestFile();
          if (newest) {
            watchFile(newest);
          }
          watchSessionDir();
        }
      }, 2000);
      intervals.push(waitInterval);
    }
  }

  // Keep process alive until Ctrl+C
  await new Promise<void>((resolve) => {
    const onSigint = (): void => {
      cleanup();
      process.off('SIGINT', onSigint);
      resolve();
    };
    process.on('SIGINT', onSigint);
  });
}
