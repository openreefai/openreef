import { loadState, listStates } from '../core/state-manager.js';
import type { FormationState } from '../types/state.js';

export class FormationNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Formation "${identifier}" not found.`);
    this.name = 'FormationNotFoundError';
  }
}

export class AmbiguousFormationError extends Error {
  matches: FormationState[];
  constructor(name: string, matches: FormationState[]) {
    super(`Multiple formations named "${name}" found.`);
    this.name = 'AmbiguousFormationError';
    this.matches = matches;
  }
}

export function parseIdentifier(
  identifier: string,
): { namespace?: string; name: string } {
  const slash = identifier.indexOf('/');
  if (slash !== -1) {
    return {
      namespace: identifier.slice(0, slash),
      name: identifier.slice(slash + 1),
    };
  }
  return { name: identifier };
}

/**
 * Resolve an identifier (namespace/name or bare name) to a FormationState.
 * Throws FormationNotFoundError if no match, AmbiguousFormationError if >1 match.
 */
export async function resolveFormationState(
  identifier: string,
  env?: NodeJS.ProcessEnv,
): Promise<FormationState> {
  const parsed = parseIdentifier(identifier);

  if (parsed.namespace) {
    const state = await loadState(parsed.namespace, parsed.name, env);
    if (!state) {
      throw new FormationNotFoundError(identifier);
    }
    return state;
  }

  // Search all states for unique match by name
  const allStates = await listStates(env);
  const matches = allStates.filter((s) => s.name === parsed.name);

  if (matches.length === 0) {
    throw new FormationNotFoundError(parsed.name);
  }
  if (matches.length > 1) {
    throw new AmbiguousFormationError(parsed.name, matches);
  }

  return matches[0];
}
