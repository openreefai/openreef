import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeFileHash } from './state-manager.js';
import { bindingsEqual } from './config-patcher.js';
import type { FormationState, CronJobState, OpenClawBinding } from '../types/state.js';
import type { CronJob } from './gateway-client.js';

export interface Discrepancy {
  kind: 'agent' | 'binding' | 'cron' | 'file' | 'a2a';
  type: 'missing' | 'orphaned' | 'changed';
  description: string;
  agentId?: string;
  fixable: boolean;
  needsSource: boolean;
}

export function diffStateVsConfig(
  state: FormationState,
  config: Record<string, unknown>,
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const agentsList = (
    (config.agents as Record<string, unknown>)?.list as Record<string, unknown>[]
  ) ?? [];

  // Check each agent in state exists in config
  for (const agent of Object.values(state.agents)) {
    const found = agentsList.some((a) => a.id === agent.id);
    if (!found) {
      discrepancies.push({
        kind: 'agent',
        type: 'missing',
        description: `${agent.slug} (${agent.id}) not in config`,
        agentId: agent.id,
        fixable: true,
        needsSource: false,
      });
    }
  }

  // Check bindings
  const configBindings = (config.bindings ?? []) as OpenClawBinding[];
  for (const binding of state.bindings) {
    const found = configBindings.some((b) => bindingsEqual(b, binding));
    if (!found) {
      discrepancies.push({
        kind: 'binding',
        type: 'missing',
        description: `${binding.match.channel} → ${binding.agentId} not in config`,
        fixable: true,
        needsSource: false,
      });
    }
  }

  // Check a2a
  if (state.agentToAgent?.allowAdded) {
    const tools = config.tools as Record<string, unknown> | undefined;
    const a2a = tools?.agentToAgent as Record<string, unknown> | undefined;
    const allow = (a2a?.allow as string[]) ?? [];
    const pattern = `${state.namespace}-*`;
    if (!allow.includes(pattern)) {
      discrepancies.push({
        kind: 'a2a',
        type: 'missing',
        description: `Agent-to-agent allow pattern "${pattern}" not in config`,
        fixable: true,
        needsSource: false,
      });
    }
  }

  return discrepancies;
}

export function diffStateVsFilesystem(
  state: FormationState,
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  for (const agent of Object.values(state.agents)) {
    if (!existsSync(agent.workspace)) {
      discrepancies.push({
        kind: 'file',
        type: 'missing',
        description: `Workspace ${agent.workspace} missing`,
        agentId: agent.id,
        fixable: false,
        needsSource: true,
      });
    }
  }

  // Check individual file hashes
  for (const [key, expectedHash] of Object.entries(state.fileHashes)) {
    // key format: "agentId:relativePath"
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) continue;
    const agentId = key.slice(0, colonIdx);
    const relativePath = key.slice(colonIdx + 1);

    // Find the agent
    const agent = Object.values(state.agents).find((a) => a.id === agentId);
    if (!agent) continue;

    const filePath = join(agent.workspace, relativePath);
    if (!existsSync(filePath)) {
      discrepancies.push({
        kind: 'file',
        type: 'missing',
        description: `File ${relativePath} missing from ${agent.slug} workspace`,
        agentId: agent.id,
        fixable: false,
        needsSource: true,
      });
    } else {
      // File exists — check hash
      const actualContent = readFileSync(filePath);
      const actualHash = computeFileHash(actualContent);
      if (actualHash !== expectedHash) {
        discrepancies.push({
          kind: 'file',
          type: 'changed',
          description: `File ${relativePath} changed in ${agent.slug} workspace`,
          agentId: agent.id,
          fixable: false,
          needsSource: true,
        });
      }
    }
  }

  return discrepancies;
}

export function diffStateVsCron(
  state: FormationState,
  liveCronJobs: CronJob[] | null,
): Discrepancy[] {
  if (liveCronJobs === null) return [];

  const discrepancies: Discrepancy[] = [];
  const liveIds = new Set(liveCronJobs.map((j) => j.id));

  for (const job of state.cronJobs) {
    if (!liveIds.has(job.id)) {
      const hasScheduleData = !!(job.schedule && job.prompt);
      discrepancies.push({
        kind: 'cron',
        type: 'missing',
        description: `Cron job ${job.name} (${job.id}) not found on Gateway`,
        fixable: hasScheduleData,
        needsSource: !hasScheduleData,
      });
    }
  }

  return discrepancies;
}

export function collectDiscrepancies(
  state: FormationState,
  config: Record<string, unknown>,
  liveCronJobs: CronJob[] | null,
): Discrepancy[] {
  return [
    ...diffStateVsConfig(state, config),
    ...diffStateVsFilesystem(state),
    ...diffStateVsCron(state, liveCronJobs),
  ];
}
