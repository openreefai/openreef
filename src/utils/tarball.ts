import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extract } from 'tar';
import {
  isBareFormationName,
  parseRegistryRef,
  resolveFromRegistry,
} from '../core/registry.js';

export interface ResolveOptions {
  registryUrl?: string;
  skipCache?: boolean;
}

export interface ResolvedFormation {
  formationPath: string;
  tempDir: string | null;
  registryRef?: { name: string; version: string };
}

/**
 * Resolve a formation source to a local directory path.
 *
 * Resolution order (local-first):
 * 1. Tarball (.tar.gz, .tgz) → extract to temp dir
 * 2. Local path exists → use as-is (local always wins)
 * 3. Bare formation name → resolve from registry
 * 4. Otherwise → treat as local path (fails naturally in manifest loader)
 *
 * Caller is responsible for cleaning up the temp directory if one was created.
 */
export async function resolveFormationPath(
  inputPath: string,
  options?: ResolveOptions,
): Promise<ResolvedFormation> {
  // 1. Tarball?
  if (isTarball(inputPath)) {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-install-'));
    await extract({ file: inputPath, cwd: tempDir });
    return { formationPath: tempDir, tempDir };
  }

  // 2. Local path exists? (local always wins)
  if (existsSync(inputPath)) {
    return { formationPath: inputPath, tempDir: null };
  }

  // 3. Bare formation name? → resolve from registry
  if (isBareFormationName(inputPath)) {
    const { name, version } = parseRegistryRef(inputPath);
    const result = await resolveFromRegistry(name, version, {
      registryUrl: options?.registryUrl,
      skipCache: options?.skipCache,
    });
    return {
      formationPath: result.formationPath,
      tempDir: result.tempDir,
      registryRef: { name: result.name, version: result.version },
    };
  }

  // 4. Fallthrough → treat as local path
  return { formationPath: inputPath, tempDir: null };
}

function isTarball(path: string): boolean {
  return (
    path.endsWith('.tar.gz') ||
    path.endsWith('.tgz') ||
    path.endsWith('.reef.tar.gz')
  );
}
