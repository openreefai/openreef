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
  lines.push('## How to communicate');
  lines.push('');
  lines.push('Use `sessions_spawn` to start a conversation with an agent:');
  lines.push('');
  lines.push('```');
  lines.push(`sessions_spawn(agentId: "${namespace}-<agent>", task: "Your request here")`);
  lines.push('```');
  lines.push('');
  lines.push('This creates a new session for the target agent and sends your task.');
  lines.push('Use the returned `childSessionKey` with `sessions_send` for follow-up messages.');
  lines.push('');
  lines.push('**Do NOT use `sessions_send` for first contact** — it requires an existing session.');
  lines.push('');

  return lines.join('\n');
}
