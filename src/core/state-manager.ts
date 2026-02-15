import {
  readFile,
  writeFile,
  unlink,
  readdir,
  mkdir,
  rm,
  rename,
  mkdtemp,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveReefStateDir } from './openclaw-paths.js';
import { copyDir } from '../utils/fs.js';
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

export function sourceSnapshotDir(
  namespace: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): string {
  const dir = resolveReefStateDir(env);
  return join(dir, 'sources', `${namespace}--${name}`);
}

export async function persistSourceSnapshot(
  formationPath: string,
  namespace: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const snapshotDir = sourceSnapshotDir(namespace, name, env);

  const srcAbs = resolve(formationPath);
  const dstAbs = resolve(snapshotDir);

  // Exact equality: source is already the snapshot, no-op
  if (srcAbs === dstAbs) {
    return snapshotDir;
  }

  // Containment: throw — programming error or corrupted state
  if (srcAbs.startsWith(dstAbs + sep) || dstAbs.startsWith(srcAbs + sep)) {
    throw new Error(
      `Cannot persist source snapshot: paths overlap (src=${srcAbs}, dst=${dstAbs})`,
    );
  }

  // Atomic write: copy to temp dir, then rename to final location
  const sourcesParent = join(resolveReefStateDir(env), 'sources');
  await mkdir(sourcesParent, { recursive: true });
  const tmpDir = await mkdtemp(join(sourcesParent, `${namespace}--${name}.tmp-`));
  try {
    await copyDir(formationPath, tmpDir);
    // Backup-rename swap for durability
    const bakDir = snapshotDir + '.bak';
    const hadOld = existsSync(snapshotDir);
    if (hadOld) {
      await rm(bakDir, { recursive: true, force: true }).catch(() => {});
      await rename(snapshotDir, bakDir);
    }
    try {
      await rename(tmpDir, snapshotDir);
    } catch (renameErr) {
      if (hadOld) await rename(bakDir, snapshotDir).catch(() => {});
      throw renameErr;
    }
    if (hadOld) {
      await rm(bakDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return snapshotDir;
}

export async function deleteSourceSnapshot(
  namespace: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const snapshotDir = sourceSnapshotDir(namespace, name, env);
  await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
}
