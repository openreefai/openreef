const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(TOKEN_PATTERN, (match, name: string) => {
    if (name in variables) {
      return variables[name];
    }
    // Leave undeclared tokens untouched per spec
    return match;
  });
}

/**
 * Build a markdown list of an agent's enabled tools/skills.
 * Format: `- **tool-name** (version-range)` for skills with versions,
 *         `- **tool-name**` for built-in tools without a version.
 */
export function buildToolsList(
  agentTools: string[] | undefined,
  skills: Record<string, string> | undefined,
): string {
  if (!agentTools?.length) return '';

  const lines = agentTools.map((tool) => {
    const version = skills?.[tool];
    return version ? `- **${tool}** (${version})` : `- **${tool}**`;
  });

  return lines.join('\n');
}
