import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest } from '../core/manifest-loader.js';
import { resolveSkillsDependencies } from '../core/skills-registry.js';
import { icons } from '../utils/output.js';
import chalk from 'chalk';
import type { Lockfile } from '../types/lockfile.js';

export interface LockOptions {
  registryUrl?: string;
  skipCache?: boolean;
}

export async function lock(
  formationPath: string,
  options?: LockOptions,
): Promise<void> {
  const manifest = await loadManifest(formationPath);

  if (!manifest.dependencies?.skills || Object.keys(manifest.dependencies.skills).length === 0) {
    console.log('No skill dependencies to lock.');
    return;
  }

  console.log(`Resolving ${Object.keys(manifest.dependencies.skills).length} skill dependencies...`);

  const lockfile = await resolveSkillsDependencies(
    manifest.dependencies.skills,
    { registryUrl: options?.registryUrl, skipCache: options?.skipCache },
  );

  // Preserve _comment from existing lockfile if present
  const lockfilePath = join(formationPath, 'reef.lock.json');
  let existingComment: string | undefined;
  try {
    const existing = JSON.parse(await readFile(lockfilePath, 'utf-8'));
    if (existing._comment) {
      existingComment = existing._comment;
    }
  } catch {
    // No existing lockfile
  }

  const output: Record<string, unknown> = {};
  if (existingComment) {
    output._comment = existingComment;
  }
  output.skills = lockfile.skills;

  await writeFile(lockfilePath, JSON.stringify(output, null, 2) + '\n');

  const skillCount = Object.keys(lockfile.skills).length;
  const versions = Object.entries(lockfile.skills)
    .map(([name, entry]) => `${name}@${entry.version}`)
    .join(', ');
  console.log(
    `${icons.success} ${chalk.green(`Locked ${skillCount} skills: ${versions}`)}`,
  );
}
