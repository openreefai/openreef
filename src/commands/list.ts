import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { readConfig } from '../core/config-patcher.js';
import { listStates } from '../core/state-manager.js';
import { icons, header, label, value, table } from '../utils/output.js';
import type { FormationState } from '../types/state.js';

export interface ListOptions {
  json?: boolean;
}

function computeStatus(
  state: FormationState,
  configAgentIds: Set<string>,
): string {
  const agentsOk = Object.values(state.agents).every(
    (a) => configAgentIds.has(a.id) && existsSync(a.workspace),
  );
  if (!agentsOk) return 'degraded';
  return 'healthy';
}

export async function list(options: ListOptions): Promise<void> {
  const states = await listStates();

  // Read config once to check agent presence
  let configAgentIds = new Set<string>();
  try {
    const { config } = await readConfig();
    const agentsList = (
      (config.agents as Record<string, unknown>)?.list as Record<
        string,
        unknown
      >[]
    ) ?? [];
    configAgentIds = new Set(agentsList.map((a) => a.id as string));
  } catch {
    // Config not readable — all statuses will be 'degraded'
  }

  if (options.json) {
    const output = states.map((s) => ({
      namespace: s.namespace,
      name: s.name,
      version: s.version,
      agents: Object.keys(s.agents).length,
      bindings: s.bindings.length,
      cronJobs: s.cronJobs.length,
      status: computeStatus(s, configAgentIds),
      installedAt: s.installedAt,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (states.length === 0) {
    console.log(`${icons.info} No formations installed.`);
    console.log('');
    console.log(`  ${label('Deploy one:')} reef install <path>`);
    return;
  }

  console.log('');
  console.log(header('Installed Formations'));
  console.log('');

  const rows: string[][] = [
    [
      chalk.dim('NAMESPACE'),
      chalk.dim('NAME'),
      chalk.dim('VERSION'),
      chalk.dim('AGENTS'),
      chalk.dim('STATUS'),
      chalk.dim('INSTALLED'),
    ],
  ];

  for (const s of states) {
    const date = new Date(s.installedAt);
    const dateStr = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const status = computeStatus(s, configAgentIds);
    const statusText =
      status === 'healthy'
        ? chalk.green('healthy')
        : chalk.yellow('degraded');
    rows.push([
      s.namespace,
      s.name,
      s.version,
      String(Object.keys(s.agents).length),
      statusText,
      dateStr,
    ]);
  }

  console.log(table(rows));
  console.log('');
  console.log(
    `  ${label('Details:')} reef status <namespace>/<name>`,
  );
}
