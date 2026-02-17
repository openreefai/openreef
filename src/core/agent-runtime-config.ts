import type { AgentTools, ReefManifest } from '../types/manifest.js';
import { normalizeToolName } from './tool-names.js';

function normalizeAllowList(allow?: string[]): string[] | undefined {
  if (!allow) return undefined;
  return Array.from(
    new Set(
      allow
        .map((name) => normalizeToolName(name))
        .filter((name) => name.length > 0),
    ),
  );
}

export function normalizeAgentTools(
  tools?: AgentTools,
): Record<string, unknown> | undefined {
  if (!tools) return undefined;

  const normalizedAllow = normalizeAllowList(tools.allow);
  const out: Record<string, unknown> = { ...(tools as Record<string, unknown>) };

  if (normalizedAllow) {
    out.allow = normalizedAllow;
  }

  return out;
}

export function buildSubagentConfig(
  manifest: ReefManifest,
  slug: string,
  idMap: Map<string, string>,
): Record<string, unknown> | undefined {
  const agent = manifest.agents[slug];
  if (!agent) return undefined;

  const normalizedTools = normalizeAllowList(agent.tools?.allow) ?? [];
  if (!normalizedTools.includes('sessions_spawn')) {
    return undefined;
  }

  const targets = manifest.agentToAgent?.[slug] ?? [];
  const allowAgents = Array.from(
    new Set(
      targets
        .map((target) => idMap.get(target))
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ).sort();

  return { allowAgents };
}
