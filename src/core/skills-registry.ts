import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadArtifact } from '../utils/download.js';
import { resolveRange } from '../utils/semver.js';
import { parseSemver, satisfiesRange } from '../utils/semver.js';
import { resolveReefStateDir } from './openclaw-paths.js';
import { VERSION } from '../version.js';
import type { RegistryVersionEntry, RegistryOptions } from './registry.js';
import type { Lockfile, LockfileEntry } from '../types/lockfile.js';

// ── Types ──

export interface SkillsRegistryIndex {
  skills: Record<string, { latest: string; versions: Record<string, RegistryVersionEntry> }>;
}

// ── Error classes ──

export class SkillNotFoundError extends Error {
  constructor(public skillName: string) {
    super(`Skill "${skillName}" not found in skills registry`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillVersionNotFoundError extends Error {
  constructor(public skillName: string, public versionRange: string) {
    super(`No version matching "${versionRange}" found for skill "${skillName}"`);
    this.name = 'SkillVersionNotFoundError';
  }
}

export class LockfileViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockfileViolationError';
  }
}

// ── Constants ──

const DEFAULT_SKILLS_REGISTRY_URL =
  'https://raw.githubusercontent.com/openreefai/skills/main/index.json';

// ── Helpers ──

function resolveSkillsRegistryUrl(options?: RegistryOptions): string {
  const env = options?.env ?? process.env;
  return options?.registryUrl ?? env.REEF_SKILLS_REGISTRY_URL ?? DEFAULT_SKILLS_REGISTRY_URL;
}

function skillsCacheDir(options?: RegistryOptions): string {
  const env = options?.env ?? process.env;
  const reefStateDir = resolveReefStateDir(env);
  return join(reefStateDir, 'cache', 'skills');
}

function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ── Core functions ──

export async function fetchSkillsIndex(options?: RegistryOptions): Promise<SkillsRegistryIndex> {
  const registryUrl = resolveSkillsRegistryUrl(options);

  const response = await fetch(registryUrl, {
    headers: { 'User-Agent': `@openreef/cli/${VERSION}` },
  });

  if (!response.ok) {
    throw new Error(`Skills registry returned HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as SkillsRegistryIndex;
  if (!data.skills || typeof data.skills !== 'object') {
    throw new Error('Skills registry index has invalid format (missing skills object)');
  }

  return data;
}

export function lookupSkill(
  index: SkillsRegistryIndex,
  name: string,
  versionRange?: string,
): { entry: RegistryVersionEntry; resolvedVersion: string } {
  const skill = index.skills[name];
  if (!skill) {
    throw new SkillNotFoundError(name);
  }

  if (!versionRange || versionRange === 'latest') {
    const entry = skill.versions[skill.latest];
    if (!entry) {
      throw new SkillVersionNotFoundError(name, skill.latest);
    }
    return { entry, resolvedVersion: skill.latest };
  }

  const versions = Object.keys(skill.versions);
  const resolved = resolveRange(versions, versionRange);
  if (!resolved) {
    throw new SkillVersionNotFoundError(name, versionRange);
  }

  return { entry: skill.versions[resolved], resolvedVersion: resolved };
}

export async function resolveSkillsDependencies(
  skills: Record<string, string>,
  options?: RegistryOptions,
): Promise<Lockfile> {
  const index = await fetchSkillsIndex(options);
  const lockfileSkills: Record<string, LockfileEntry> = {};

  for (const [name, range] of Object.entries(skills)) {
    const { entry, resolvedVersion } = lookupSkill(index, name, range);

    // Download the artifact to compute integrity hash
    const cacheDir = skillsCacheDir(options);
    const disambig = hashString(`${name}:${resolvedVersion}`).slice(0, 8);
    const cacheName = `${name}-${resolvedVersion}-${disambig}.tar.gz`;

    const artifactPath = await downloadArtifact({
      url: entry.url,
      sha256: entry.sha256,
      cacheDir,
      cacheName,
      userAgent: `@openreef/cli/${VERSION}`,
    });

    const content = await readFile(artifactPath);
    const integrity = `sha256-${createHash('sha256').update(content).digest('hex')}`;

    lockfileSkills[name] = {
      version: resolvedVersion,
      resolved: entry.url,
      integrity,
    };
  }

  return { skills: lockfileSkills };
}

export async function verifyLockfileIntegrity(
  lockfile: Lockfile,
  options?: RegistryOptions,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const cacheDir = skillsCacheDir(options);

  for (const [name, entry] of Object.entries(lockfile.skills)) {
    // Skip integrity verification for entries without integrity hashes or non-downloadable URIs
    if (entry.integrity == null) {
      continue;
    }
    if (!entry.resolved.startsWith('https://') && !entry.resolved.startsWith('http://')) {
      continue;
    }
    try {
      const disambig = hashString(`${name}:${entry.version}`).slice(0, 8);
      const cacheName = `${name}-${entry.version}-${disambig}.tar.gz`;

      // Download from lockfile resolved URL (not re-resolved from registry)
      const artifactPath = await downloadArtifact({
        url: entry.resolved,
        sha256: undefined, // We verify ourselves against lockfile integrity
        cacheDir,
        cacheName: `verify-${cacheName}`,
        userAgent: `@openreef/cli/${VERSION}`,
      });

      const content = await readFile(artifactPath);
      const actual = `sha256-${createHash('sha256').update(content).digest('hex')}`;

      if (actual !== entry.integrity) {
        errors.push(
          `Integrity mismatch for ${name}@${entry.version}: expected ${entry.integrity}, got ${actual}`,
        );
      }
    } catch (err) {
      errors.push(
        `Failed to verify ${name}@${entry.version}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

const SHA256_HEX_RE = /^sha256-[0-9a-f]{64}$/;

export async function enforceLockfile(
  formationPath: string,
  skills: Record<string, string>,
  options?: RegistryOptions,
): Promise<void> {
  const lockfilePath = join(formationPath, 'reef.lock.json');
  let lockfileRaw: string;
  try {
    lockfileRaw = await readFile(lockfilePath, 'utf-8');
  } catch {
    // No lockfile — warn and return
    console.warn(
      'No reef.lock.json found. Run `reef lock` to pin skill versions for supply-chain safety.',
    );
    return;
  }

  const parsed = JSON.parse(lockfileRaw) as Record<string, unknown>;
  // Support both formats: top-level { skills } (reef lock output) and nested { dependencies: { skills } } (reef-forge scaffolded)
  const rawSkills =
    (parsed.skills as Record<string, LockfileEntry> | undefined) ??
    ((parsed.dependencies as Record<string, unknown> | undefined)?.skills as Record<string, LockfileEntry> | undefined) ??
    {};
  const lockfile: Lockfile = { skills: rawSkills };

  // Warn about extra entries in lockfile (skills not in manifest)
  for (const lockedName of Object.keys(lockfile.skills)) {
    if (!(lockedName in skills)) {
      console.warn(
        `Warning: Lockfile contains skill "${lockedName}" which is not declared in reef.json dependencies.skills. Consider running \`reef lock\` to regenerate.`,
      );
    }
  }

  // Check each declared skill
  const missingIntegrity: string[] = [];
  for (const [name, range] of Object.entries(skills)) {
    const entry = lockfile.skills[name];
    if (!entry) {
      throw new LockfileViolationError(
        `Skill "${name}" is declared in reef.json but missing from reef.lock.json. Run \`reef lock\` to regenerate.`,
      );
    }

    // Validate entry format
    if (entry.integrity != null && !SHA256_HEX_RE.test(entry.integrity)) {
      throw new LockfileViolationError(
        `Malformed integrity for "${name}" in lockfile: expected "sha256-<64 hex chars>", got "${entry.integrity}"`,
      );
    }
    if (entry.integrity == null) {
      missingIntegrity.push(name);
    }

    const validSchemes = ['https://', 'http://', 'clawhub:'];
    if (!validSchemes.some((s) => entry.resolved.startsWith(s))) {
      throw new LockfileViolationError(
        `Malformed resolved URI for "${name}" in lockfile: expected https://, http://, or clawhub: scheme, got "${entry.resolved}"`,
      );
    }

    try {
      parseSemver(entry.version);
    } catch {
      throw new LockfileViolationError(
        `Malformed version for "${name}" in lockfile: "${entry.version}" is not a valid semver string`,
      );
    }

    // Check range satisfaction
    if (!satisfiesRange(entry.version, range)) {
      throw new LockfileViolationError(
        `Locked version ${entry.version} for "${name}" does not satisfy declared range "${range}". Run \`reef lock\` to update.`,
      );
    }
  }

  if (missingIntegrity.length > 0) {
    console.warn(
      `Warning: ${missingIntegrity.length} skill(s) missing integrity hashes in lockfile (${missingIntegrity.join(', ')}). Run \`reef lock\` to add supply-chain verification.`,
    );
  }

  // Verify integrity
  const verification = await verifyLockfileIntegrity(lockfile, options);
  if (!verification.valid) {
    throw new LockfileViolationError(
      `Lockfile integrity check failed:\n  ${verification.errors.join('\n  ')}`,
    );
  }
}
