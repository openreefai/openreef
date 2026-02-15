import { rm } from 'node:fs/promises';
import ora from 'ora';
import chalk from 'chalk';
import { resolveGatewayUrl } from '../core/openclaw-paths.js';
import {
  readConfig,
  writeConfig,
  removeAgentEntry,
  removeBinding,
  removeAgentToAgent,
} from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth } from '../core/gateway-client.js';
import {
  loadState,
  deleteState,
  listStates,
} from '../core/state-manager.js';
import { icons, header, label, value } from '../utils/output.js';

export interface UninstallOptions {
  yes?: boolean;
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

export async function uninstall(
  identifier: string,
  options: UninstallOptions,
): Promise<void> {
  // 1. Resolve identifier to state
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
    // Search all states for unique match by name
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

  // 2. Confirm
  if (!options.yes) {
    console.log('');
    console.log(header('Uninstall'));
    console.log('');
    console.log(
      `${label('Formation:')} ${value(`${state.namespace}/${state.name}`)} v${state.version}`,
    );
    console.log(
      `${label('Agents:')} ${Object.keys(state.agents).length}`,
    );
    console.log(`${label('Bindings:')} ${state.bindings.length}`);
    console.log(`${label('Cron Jobs:')} ${state.cronJobs.length}`);
    console.log('');

    const { confirm } = await import('@inquirer/prompts');
    const ok = await confirm({
      message: 'Remove this formation and all its resources?',
    });
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const spinner = ora('Uninstalling formation...').start();

  // 3. Remove cron jobs via Gateway RPC
  if (state.cronJobs.length > 0) {
    spinner.text = 'Removing cron jobs...';
    const { config } = await readConfig();
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

    try {
      await gw.connect();
      for (const job of state.cronJobs) {
        try {
          await gw.cronRemove(job.id);
        } catch {
          // Job may already be gone
        }
      }
      gw.close();
    } catch {
      spinner.warn(
        'Could not connect to Gateway for cron removal — jobs may be orphaned',
      );
    }
  }

  // 4. Patch config
  spinner.text = 'Removing config entries...';
  let { config, path: configPath } = await readConfig();

  for (const binding of state.bindings) {
    config = removeBinding(config, binding);
  }

  for (const agent of Object.values(state.agents)) {
    config = removeAgentEntry(config, agent.id);
  }

  // Remove agentToAgent allow entry if no other formations share namespace
  if (state.agentToAgent?.allowAdded) {
    const allStates = await listStates();
    const otherInNamespace = allStates.some(
      (s) =>
        s.namespace === state!.namespace &&
        s.name !== state!.name,
    );
    config = removeAgentToAgent(
      config,
      state.namespace,
      otherInNamespace,
      state.agentToAgent.wasEnabled,
    );
  }

  await writeConfig(configPath, config, { silent: true });

  // 5. Delete workspace directories
  spinner.text = 'Removing workspace directories...';
  for (const agent of Object.values(state.agents)) {
    try {
      await rm(agent.workspace, { recursive: true, force: true });
    } catch {
      // Already gone
    }
  }

  // 6. Delete state
  await deleteState(state.namespace, state.name);

  spinner.succeed('Formation uninstalled');
  console.log('');
  console.log(
    `${icons.success} ${chalk.green(`Removed ${Object.keys(state.agents).length} agents, ${state.bindings.length} bindings, ${state.cronJobs.length} cron jobs`)}`,
  );
}
