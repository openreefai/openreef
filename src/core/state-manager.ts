import {
  readFile,
  writeFile,
  unlink,
  readdir,
  mkdir,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveReefStateDir } from './openclaw-paths.js';
import type { FormationState } from '../types/state.js';

function stateFileName(namespace: string, name: string): string {
  return `${namespace}--${name}.state.json`;
}

export async function loadState(
  namespace: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<FormationState | null> {
  const dir = resolveReefStateDir(env);
  const filePath = join(dir, stateFileName(namespace, name));
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as FormationState;
  } catch {
    return null;
  }
}

export async function saveState(
  state: FormationState,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const dir = resolveReefStateDir(env);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, stateFileName(state.namespace, state.name));
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export async function deleteState(
  namespace: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const dir = resolveReefStateDir(env);
  const filePath = join(dir, stateFileName(namespace, name));
  try {
    await unlink(filePath);
  } catch {
    // Already gone
  }
}

export async function listStates(
  env?: NodeJS.ProcessEnv,
): Promise<FormationState[]> {
  const dir = resolveReefStateDir(env);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const states: FormationState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.state.json')) continue;
    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      states.push(JSON.parse(raw) as FormationState);
    } catch {
      // Skip corrupt state files
    }
  }

  return states;
}

export function computeFileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
