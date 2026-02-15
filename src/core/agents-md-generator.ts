import type { ReefManifest } from '../types/manifest.js';

export function generateAgentsMd(
  manifest: ReefManifest,
  currentAgent: string,
  namespace: string,
): string {
  const edges = manifest.agentToAgent?.[currentAgent];
  if (!edges?.length) return '';

  const lines: string[] = [
    '# Available Agents',
    '',
    'You can communicate with the following agents:',
    '',
  ];

  for (const target of edges) {
    const agent = manifest.agents[target];
    if (!agent) continue;
    const id = `${namespace}-${target}`;
    const desc = agent.description ?? target;
    lines.push(`- **${target}** (\`${id}\`) — ${desc}`);
  }

  lines.push('');
  lines.push('Send a message by addressing the agent by name.');
  lines.push('');

  return lines.join('\n');
}
