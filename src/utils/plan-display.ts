import chalk from 'chalk';
import { header, label } from './output.js';
import type { MigrationPlan } from '../core/migration-planner.js';
import {
  extractChannelType,
  isBareChannel,
  getConfiguredChannels,
} from '../core/config-patcher.js';

export function displayMigrationPlan(
  plan: MigrationPlan,
  namespace: string,
  name: string,
): void {
  console.log('');
  const versionStr = plan.versionChange
    ? ` v${plan.versionChange.from} → v${plan.versionChange.to}`
    : '';
  console.log(
    header(`Migration Plan: ${namespace}/${name}${versionStr}`),
  );
  console.log('');

  // Agents
  console.log(label('Agents:'));
  for (const a of plan.agents) {
    switch (a.type) {
      case 'add':
        console.log(`  ${chalk.green('+')} ${a.slug} (add)`);
        break;
      case 'remove':
        console.log(`  ${chalk.red('-')} ${a.slug} (remove)`);
        break;
      case 'update':
        console.log(
          `  ${chalk.yellow('~')} ${a.slug} (${a.changedFiles?.length} files changed)`,
        );
        break;
      case 'unchanged':
        console.log(`  ${chalk.dim('=')} ${a.slug} (unchanged)`);
        break;
    }
  }

  // Bindings
  if (plan.bindings.length > 0) {
    console.log('');
    console.log(label('Bindings:'));
    for (const b of plan.bindings) {
      if (b.type === 'add') {
        const channelType = extractChannelType(b.binding.match.channel);
        const bare = isBareChannel(b.binding.match.channel);
        let annotation = '';
        if (bare) {
          annotation = chalk.dim(' (bare channel — shadows main)');
        }
        console.log(
          `  ${chalk.green('+')} ${b.binding.match.channel} → ${b.binding.agentId}${annotation}`,
        );
      } else {
        console.log(
          `  ${chalk.red('-')} ${b.binding.match.channel} → ${b.binding.agentId}`,
        );
      }
    }
  }

  // Cron
  if (plan.cron.length > 0) {
    console.log('');
    console.log(label('Cron Jobs:'));
    for (const c of plan.cron) {
      switch (c.type) {
        case 'add':
          console.log(`  ${chalk.green('+')} ${c.name}`);
          break;
        case 'remove':
          console.log(`  ${chalk.red('-')} ${c.name}`);
          break;
        case 'update':
          console.log(`  ${chalk.yellow('~')} ${c.name}`);
          break;
      }
    }
  }

  // A2a
  if (plan.a2a.length > 0) {
    console.log('');
    console.log(label('Agent-to-Agent:'));
    for (const edge of plan.a2a) {
      const prefix =
        edge.type === 'add'
          ? chalk.green('+')
          : edge.type === 'remove'
            ? chalk.red('-')
            : chalk.yellow('~');
      console.log(`  ${prefix} ${edge.from} → ${edge.to}`);
    }
  }
}
