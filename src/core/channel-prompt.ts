/**
 * Normalize a channel string to `type:scope` form.
 * Returns null if the input is invalid (missing type, missing scope, etc.).
 */
export function normalizeChannel(raw: string): string | null {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) return null;

  const type = trimmed.slice(0, colonIdx).trim().toLowerCase();
  const scope = trimmed.slice(colonIdx + 1).trim();

  if (type.length === 0 || scope.length === 0) return null;

  return `${type}:${scope}`;
}
