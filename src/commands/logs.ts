import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { discoverLogs, readAgentLogs, readLogTail } from '../core/log-reader.js';
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

  // Follow mode for single agent
  if (options.follow && agents.length === 1) {
    const discovery = await discoverLogs(agents[0].id);
    if (discovery && discovery.logFiles.length > 0) {
      const latestFile = join(
        discovery.sessionDir,
        discovery.logFiles[discovery.logFiles.length - 1],
      );
      await tailFollow(latestFile);
    }
  }
}

async function tailFollow(filePath: string): Promise<void> {
  console.log(chalk.dim('\n--- Following (Ctrl+C to stop) ---\n'));

  let lastSize = 0;
  try {
    const { stat: fsStat } = await import('node:fs/promises');
    const s = await fsStat(filePath);
    lastSize = s.size;
  } catch {
    // File may not exist yet
  }

  const watcher = watch(filePath, async () => {
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

  // Keep process alive
  await new Promise<void>(() => {
    process.on('SIGINT', () => {
      watcher.close();
      process.exit(0);
    });
  });
}
