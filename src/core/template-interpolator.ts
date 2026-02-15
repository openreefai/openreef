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
