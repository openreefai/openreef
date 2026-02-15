import { rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { existsSync } from 'node:fs';
import ora from 'ora';
import chalk from 'chalk';
import { resolveGatewayUrl, resolveStateDir, resolveAgentStatePaths } from '../core/openclaw-paths.js';
import {
  readConfig,
  writeConfig,
  removeAgentEntry,
  removeBinding,
  removeAgentToAgent,
} from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth } from '../core/gateway-client.js';
import {
  deleteState,
  listStates,
  deleteSourceSnapshot,
} from '../core/state-manager.js';
import { icons, header, label, value } from '../utils/output.js';
import {
  resolveFormationState,
  FormationNotFoundError,
  AmbiguousFormationError,
} from '../utils/identifiers.js';

export interface UninstallOptions {
  yes?: boolean;
  dryRun?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
}

export async function uninstall(
  identifier: string,
  options: UninstallOptions,
): Promise<void> {
  // 1. Resolve identifier to state
  let state;
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

  // 2. Dry run
  if (options.dryRun) {
    console.log('');
    console.log(header('Dry Run — No changes will be made'));
    console.log('');
    console.log('Would remove:');
    for (const agent of Object.values(state.agents)) {
      console.log(`  - Agent ${agent.id} from config`);
      console.log(`  - Workspace ${agent.workspace}`);
    }
    for (const binding of state.bindings) {
      console.log(`  - Binding ${binding.match.channel} → ${binding.agentId}`);
    }
    for (const job of state.cronJobs) {
      console.log(`  - Cron job ${job.name} (${job.id})`);
    }
    console.log(`  - State file ${state.namespace}/${state.name}`);
    return;
  }

  // 3. Confirm
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

  // 4. Gateway RPC cleanup — agents.delete + cron removal
  // Always attempt Gateway connection (not just for cron), because agents.delete
  // invalidates the agent in Gateway's runtime state, preventing dashboard ghosts.
  spinner.text = 'Cleaning up Gateway state...';
  const { config: gwConfig } = await readConfig();
  const gwUrl =
    options.gatewayUrl ?? resolveGatewayUrl(gwConfig, process.env);
  const gwAuth = resolveGatewayAuth({
    gatewayUrl: options.gatewayUrl,
    gatewayToken: options.gatewayToken,
    gatewayPassword: options.gatewayPassword,
    config: gwConfig,
  });
  const gw = new GatewayClient({
    url: gwUrl,
    ...gwAuth,
  });

  try {
    await gw.connect();
    for (const agent of Object.values(state.agents)) {
      try {
        await gw.call('agents.delete', { agentId: agent.id });
      } catch {
        // Agent may not exist in Gateway runtime — that's fine
      }
    }
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
      'Could not connect to Gateway — restart Gateway to clear agent state',
    );
  }

  // 5. Patch config
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

  // 6. Delete workspace directories
  spinner.text = 'Removing workspace directories...';
  for (const agent of Object.values(state.agents)) {
    try {
      await rm(agent.workspace, { recursive: true, force: true });
    } catch {
      // Already gone
    }
  }

  // 7. Clean up Gateway agent state (sessions, agent dir, qmd memory)
  const resolvedStateDir = resolve(resolveStateDir());
  for (const agent of Object.values(state.agents)) {
    const statePaths = resolveAgentStatePaths(agent.id);
    for (const p of statePaths) {
      if (!existsSync(p)) continue;
      // Robust containment check: resolve both paths, verify relative path
      // doesn't escape (no leading ".." segments)
      const resolvedPath = resolve(p);
      const rel = relative(resolvedStateDir, resolvedPath);
      if (rel.startsWith('..') || resolve(resolvedStateDir, rel) !== resolvedPath) {
        continue;
      }
      try {
        await rm(p, { recursive: true, force: true });
      } catch {
        // May fail if parent dir has other contents — that's fine
      }
    }
  }

  // 8. Delete state and source snapshot
  await deleteState(state.namespace, state.name);
  await deleteSourceSnapshot(state.namespace, state.name);

  spinner.succeed('Formation uninstalled');
  console.log('');
  console.log(
    `${icons.success} ${chalk.green(`Removed ${Object.keys(state.agents).length} agents, ${state.bindings.length} bindings, ${state.cronJobs.length} cron jobs`)}`,
  );
}
