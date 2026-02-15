import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { resolveGatewayUrl } from '../core/openclaw-paths.js';
import { readConfig } from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth, type CronJob } from '../core/gateway-client.js';
import { loadState, listStates } from '../core/state-manager.js';
import { icons, header, label, value, table } from '../utils/output.js';

export interface StatusOptions {
  json?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
}

function parseIdentifier(
  identifier: string,
): { namespace?: string; name: string } {
  const slash = identifier.indexOf('/');
  if (slash !== -1) {
    return {
      namespace: identifier.slice(0, slash),
      name: identifier.slice(slash + 1),
    };
  }
  return { name: identifier };
}

export async function status(
  identifier: string,
  options: StatusOptions,
): Promise<void> {
  const parsed = parseIdentifier(identifier);
  let state;

  if (parsed.namespace) {
    state = await loadState(parsed.namespace, parsed.name);
    if (!state) {
      console.error(
        `${icons.error} Formation "${identifier}" not found.`,
      );
      process.exit(1);
    }
  } else {
    const allStates = await listStates();
    const matches = allStates.filter((s) => s.name === parsed.name);
    if (matches.length === 0) {
      console.error(
        `${icons.error} No formation found with name "${parsed.name}".`,
      );
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(
        `${icons.error} Multiple formations named "${parsed.name}" found:`,
      );
      for (const m of matches) {
        console.error(`  - ${m.namespace}/${m.name}`);
      }
      console.error('  Specify the full namespace/name.');
      process.exit(1);
    }
    state = matches[0];
  }

  // Read config to check agents and bindings
  const { config } = await readConfig();
  const agentsList = (
    (config.agents as Record<string, unknown>)?.list as Record<
      string,
      unknown
    >[]
  ) ?? [];

  const bindingsList = (config.bindings ?? []) as Record<string, unknown>[];

  // Check cron jobs if Gateway reachable
  let cronJobs: CronJob[] = [];
  let cronReachable = false;
  if (state.cronJobs.length > 0) {
    try {
      const gwUrl =
        options.gatewayUrl ?? resolveGatewayUrl(config, process.env);
      const gwAuth = resolveGatewayAuth({
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        gatewayPassword: options.gatewayPassword,
        config,
      });
      const gw = new GatewayClient({
        url: gwUrl,
        ...gwAuth,
      });
      await gw.connect();
      cronJobs = await gw.cronList({ includeDisabled: true });
      cronReachable = true;
      gw.close();
    } catch {
      // Gateway not reachable — skip cron check
    }
  }

  // Build status data
  const agentStatuses = Object.entries(state.agents).map(
    ([slug, agent]) => {
      const inConfig = agentsList.some(
        (a) => (a as Record<string, unknown>).id === agent.id,
      );
      const workspaceExists = existsSync(agent.workspace);
      return {
        slug,
        id: agent.id,
        inConfig,
        workspaceExists,
        fileCount: agent.files.length,
      };
    },
  );

  const bindingStatuses = state.bindings.map((binding) => {
    const inConfig = bindingsList.some((b) => {
      const match = b.match as Record<string, unknown> | undefined;
      return b.agentId === binding.agentId && match?.channel === binding.match.channel;
    });
    return { ...binding, inConfig };
  });

  const cronStatuses = state.cronJobs.map((job) => {
    const liveJob = cronJobs.find((j) => j.id === job.id);
    return {
      ...job,
      exists: !!liveJob,
      enabled: liveJob?.enabled,
      state: liveJob?.state,
    };
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          namespace: state.namespace,
          name: state.name,
          version: state.version,
          installedAt: state.installedAt,
          agents: agentStatuses,
          bindings: bindingStatuses,
          cronJobs: cronStatuses,
          cronReachable,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Pretty print
  console.log('');
  console.log(header('Formation Status'));
  console.log('');
  console.log(
    `${label('Name:')} ${value(`${state.namespace}/${state.name}`)}`,
  );
  console.log(`${label('Version:')} ${value(state.version)}`);
  console.log(
    `${label('Installed:')} ${value(new Date(state.installedAt).toLocaleString())}`,
  );
  console.log('');

  // Agents table
  console.log(label('Agents:'));
  const agentRows: string[][] = [
    [
      chalk.dim('SLUG'),
      chalk.dim('ID'),
      chalk.dim('CONFIG'),
      chalk.dim('WORKSPACE'),
      chalk.dim('FILES'),
    ],
  ];
  for (const a of agentStatuses) {
    agentRows.push([
      a.slug,
      a.id,
      a.inConfig ? chalk.green('ok') : chalk.red('missing'),
      a.workspaceExists ? chalk.green('ok') : chalk.red('missing'),
      String(a.fileCount),
    ]);
  }
  console.log(table(agentRows));

  // Bindings
  if (bindingStatuses.length > 0) {
    console.log('');
    console.log(label('Bindings:'));
    const bindingRows: string[][] = [
      [chalk.dim('CHANNEL'), chalk.dim('AGENT'), chalk.dim('CONFIG')],
    ];
    for (const b of bindingStatuses) {
      bindingRows.push([
        b.match.channel,
        b.agentId,
        b.inConfig ? chalk.green('ok') : chalk.red('missing'),
      ]);
    }
    console.log(table(bindingRows));
  }

  // Cron
  if (cronStatuses.length > 0) {
    console.log('');
    console.log(label('Cron Jobs:'));
    if (!cronReachable) {
      console.log(
        `  ${icons.warning} ${chalk.yellow('Gateway not reachable — cannot verify cron jobs')}`,
      );
    } else {
      const cronRows: string[][] = [
        [
          chalk.dim('NAME'),
          chalk.dim('AGENT'),
          chalk.dim('STATUS'),
        ],
      ];
      for (const c of cronStatuses) {
        const statusText = c.exists
          ? c.enabled
            ? chalk.green('active')
            : chalk.yellow('disabled')
          : chalk.red('missing');
        cronRows.push([c.name, c.agentSlug, statusText]);
      }
      console.log(table(cronRows));
    }
  }

  // Overall health
  console.log('');
  const allHealthy =
    agentStatuses.every((a) => a.inConfig && a.workspaceExists) &&
    bindingStatuses.every((b) => b.inConfig) &&
    (!cronReachable || cronStatuses.every((c) => c.exists));

  if (allHealthy) {
    console.log(`${icons.success} ${chalk.green('All resources healthy')}`);
  } else {
    console.log(
      `${icons.warning} ${chalk.yellow('Some resources are missing or degraded')}`,
    );
  }
}
