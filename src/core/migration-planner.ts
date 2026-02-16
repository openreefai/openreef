import { bindingsEqual } from './config-patcher.js';
import { interpolate } from './template-interpolator.js';
import type { FormationState, OpenClawBinding, CronJobState } from '../types/state.js';
import type { ReefManifest, CronJob as ManifestCron } from '../types/manifest.js';

export interface AgentChange {
  slug: string;
  agentId: string;
  type: 'add' | 'remove' | 'update' | 'unchanged';
  changedFiles?: string[];
}

export interface BindingChange {
  binding: OpenClawBinding;
  type: 'add' | 'remove';
}

export interface CronChange {
  type: 'add' | 'remove' | 'update';
  name: string;
  agentSlug: string;
  oldCron?: CronJobState;
  newCron?: ManifestCron;
}

export interface A2aChange {
  type: 'add' | 'remove' | 'reapply';
  from: string;
  to: string;
}

export interface MigrationPlan {
  agents: AgentChange[];
  bindings: BindingChange[];
  cron: CronChange[];
  a2a: A2aChange[];
  versionChange: { from: string; to: string } | null;
  isEmpty: boolean;
}

export function computeMigrationPlan(
  state: FormationState,
  manifest: ReefManifest,
  namespace: string,
  idMap: Map<string, string>,
  newFileHashes: Record<string, string>,
  resolvedVars: Record<string, string> = {},
): MigrationPlan {
  const agents: AgentChange[] = [];
  const bindings: BindingChange[] = [];
  const cron: CronChange[] = [];
  const a2a: A2aChange[] = [];

  const oldSlugs = new Set(Object.keys(state.agents));
  const newSlugs = new Set(Object.keys(manifest.agents));

  // Agent changes
  for (const slug of newSlugs) {
    const agentId = idMap.get(slug)!;
    if (!oldSlugs.has(slug)) {
      agents.push({ slug, agentId, type: 'add' });
    } else {
      // Check for file changes
      const changedFiles: string[] = [];
      for (const [key, newHash] of Object.entries(newFileHashes)) {
        if (!key.startsWith(`${agentId}:`)) continue;
        const relativePath = key.slice(agentId.length + 1);
        const oldHash = state.fileHashes[key];
        if (oldHash !== newHash) {
          changedFiles.push(relativePath);
        }
      }
      // Check for removed files
      for (const key of Object.keys(state.fileHashes)) {
        if (!key.startsWith(`${agentId}:`)) continue;
        if (!(key in newFileHashes)) {
          const relativePath = key.slice(agentId.length + 1);
          changedFiles.push(relativePath);
        }
      }

      if (changedFiles.length > 0) {
        agents.push({ slug, agentId, type: 'update', changedFiles });
      } else {
        agents.push({ slug, agentId, type: 'unchanged' });
      }
    }
  }

  for (const slug of oldSlugs) {
    if (!newSlugs.has(slug)) {
      const agentId = state.agents[slug].id;
      agents.push({ slug, agentId, type: 'remove' });
    }
  }

  // Binding changes — interpolate {{VARIABLE}} tokens in channels
  const TOKEN_RE_CHECK = /\{\{\w+\}\}/;
  const resolvedBindings = (manifest.bindings ?? [])
    .map((b) => ({ ...b, channel: interpolate(b.channel, resolvedVars) }))
    .filter((b) => b.channel.trim() !== '' && !TOKEN_RE_CHECK.test(b.channel));

  const newBindings: OpenClawBinding[] = [];
  for (const binding of resolvedBindings) {
    const resolvedAgentId = idMap.get(binding.agent);
    if (!resolvedAgentId) continue;
    newBindings.push({
      agentId: resolvedAgentId,
      match: { channel: binding.channel },
    });
  }

  // Find added bindings
  for (const newBinding of newBindings) {
    const found = state.bindings.some((b) => bindingsEqual(b, newBinding));
    if (!found) {
      bindings.push({ binding: newBinding, type: 'add' });
    }
  }

  // Find removed bindings
  for (const oldBinding of state.bindings) {
    const found = newBindings.some((b) => bindingsEqual(b, oldBinding));
    if (!found) {
      bindings.push({ binding: oldBinding, type: 'remove' });
    }
  }

  // Cron changes
  const oldCronByName = new Map<string, CronJobState>();
  for (const job of state.cronJobs) {
    oldCronByName.set(job.name, job);
  }

  const newCronNames = new Set<string>();
  for (const [i, cronEntry] of (manifest.cron ?? []).entries()) {
    const jobName = `reef:${namespace}:${cronEntry.agent}-${i}`;
    newCronNames.add(jobName);
    const old = oldCronByName.get(jobName);

    if (!old) {
      cron.push({
        type: 'add',
        name: jobName,
        agentSlug: cronEntry.agent,
        newCron: cronEntry,
      });
    } else {
      // Check for updates (only if state has schedule/prompt fields)
      const scheduleChanged = old.schedule && old.schedule !== cronEntry.schedule;
      const promptChanged = old.prompt && old.prompt !== cronEntry.prompt;
      const timezoneChanged = old.timezone !== cronEntry.timezone;

      if (scheduleChanged || promptChanged || timezoneChanged) {
        cron.push({
          type: 'update',
          name: jobName,
          agentSlug: cronEntry.agent,
          oldCron: old,
          newCron: cronEntry,
        });
      }
    }
  }

  // Find removed cron jobs
  for (const job of state.cronJobs) {
    if (!newCronNames.has(job.name)) {
      cron.push({
        type: 'remove',
        name: job.name,
        agentSlug: job.agentSlug,
        oldCron: job,
      });
    }
  }

  // A2a changes
  const newEdges = manifest.agentToAgent ?? {};
  const oldEdges = state.agentToAgentEdges;

  if (oldEdges === undefined) {
    // v0.2.0 state — can't diff, reapply all
    for (const [from, targets] of Object.entries(newEdges)) {
      for (const to of targets) {
        a2a.push({ type: 'reapply', from, to });
      }
    }
  } else {
    // Find added edges
    for (const [from, targets] of Object.entries(newEdges)) {
      for (const to of targets) {
        if (!oldEdges[from]?.includes(to)) {
          a2a.push({ type: 'add', from, to });
        }
      }
    }
    // Find removed edges
    for (const [from, targets] of Object.entries(oldEdges)) {
      for (const to of targets) {
        if (!newEdges[from]?.includes(to)) {
          a2a.push({ type: 'remove', from, to });
        }
      }
    }
  }

  // Version change
  const versionChange =
    state.version !== manifest.version
      ? { from: state.version, to: manifest.version }
      : null;

  const isEmpty =
    agents.every((a) => a.type === 'unchanged') &&
    bindings.length === 0 &&
    cron.length === 0 &&
    a2a.length === 0 &&
    !versionChange;

  return { agents, bindings, cron, a2a, versionChange, isEmpty };
}
