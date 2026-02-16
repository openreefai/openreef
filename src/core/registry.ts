import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extract } from 'tar';
import { resolveReefStateDir } from './openclaw-paths.js';
import { downloadArtifact, ArtifactDownloadError, ArtifactIntegrityError } from '../utils/download.js';
import { VERSION } from '../version.js';

// ── Types ──

export interface RegistryVersionEntry {
  url: string;
  sha256?: string;
}

export interface RegistryFormation {
  description?: string;
  latest: string;
  versions: Record<string, RegistryVersionEntry>;
}

export interface RegistryIndex {
  version: number;
  formations: Record<string, RegistryFormation>;
}

export interface RegistryOptions {
  registryUrl?: string;
  skipCache?: boolean;
  env?: NodeJS.ProcessEnv;
}

// ── Error classes ──

export class RegistryFetchError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'RegistryFetchError';
  }
}

export class RegistryFormationNotFoundError extends Error {
  constructor(public formationName: string) {
    super(`Formation "${formationName}" not found in registry`);
    this.name = 'RegistryFormationNotFoundError';
  }
}

export class RegistryVersionNotFoundError extends Error {
  constructor(
    public formationName: string,
    public version: string,
  ) {
    super(
      `Version "${version}" not found for formation "${formationName}" in registry`,
    );
    this.name = 'RegistryVersionNotFoundError';
  }
}

export class RegistryDownloadError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'RegistryDownloadError';
  }
}

export class RegistryIntegrityError extends Error {
  constructor(
    public formationName: string,
    public version: string,
    public expected: string,
    public actual: string,
  ) {
    super(
      `Integrity check failed for ${formationName}@${version}: expected sha256 ${expected}, got ${actual}`,
    );
    this.name = 'RegistryIntegrityError';
  }
}

// ── Constants ──

const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/openreefai/formations/main/index.json';
const INDEX_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Utility functions ──

export function isBareFormationName(input: string): boolean {
  if (input.startsWith('/') || input.startsWith('.') || input.startsWith('~'))
    return false;
  if (isTarball(input)) return false;
  if (input.includes('/') || input.includes('\\')) return false;
  return /^[a-z0-9][a-z0-9_-]*(@[^\s]+)?$/i.test(input);
}

function isTarball(path: string): boolean {
  return (
    path.endsWith('.tar.gz') ||
    path.endsWith('.tgz') ||
    path.endsWith('.reef.tar.gz')
  );
}

export function parseRegistryRef(input: string): {
  name: string;
  version?: string;
} {
  const atIndex = input.indexOf('@');
  if (atIndex > 0) {
    return {
      name: input.slice(0, atIndex),
      version: input.slice(atIndex + 1),
    };
  }
  return { name: input };
}

function sanitizeFilenameComponent(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function validateUrlScheme(url: string, label: string): void {
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new RegistryFetchError(
      `Invalid URL scheme for ${label}: only https:// and http:// are allowed, got "${url}"`,
    );
  }
}

function resolveRegistryUrl(options?: RegistryOptions): string {
  const env = options?.env ?? process.env;
  return options?.registryUrl ?? env.REEF_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

// ── Cache ──

export function registryCacheDir(
  registryUrl: string,
  env?: NodeJS.ProcessEnv,
): string {
  const reefStateDir = resolveReefStateDir(env);
  const urlHash = hashString(registryUrl).slice(0, 12);
  return join(reefStateDir, 'cache', urlHash);
}

function indexCachePath(cacheDir: string): string {
  return join(cacheDir, 'registry-index.json');
}

function tarballCachePath(
  cacheDir: string,
  name: string,
  version: string,
  verified: boolean,
): string {
  const safeName = sanitizeFilenameComponent(name);
  const safeVersion = sanitizeFilenameComponent(version);
  // Include a short hash of the original name:version to prevent collisions
  // when different pairs sanitize to the same filename
  const disambig = hashString(`${name}:${version}`).slice(0, 8);
  const subdir = verified ? 'tarballs' : 'unverified';
  return join(cacheDir, subdir, `${safeName}-${safeVersion}-${disambig}.reef.tar.gz`);
}

function isValidRegistryIndex(data: unknown): data is RegistryIndex {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (
    typeof obj.formations !== 'object' ||
    obj.formations === null ||
    Array.isArray(obj.formations)
  )
    return false;
  return true;
}

// ── Core functions ──

export async function fetchRegistryIndex(
  options?: RegistryOptions,
): Promise<RegistryIndex> {
  const registryUrl = resolveRegistryUrl(options);
  validateUrlScheme(registryUrl, 'registry index');

  const cacheDir = registryCacheDir(registryUrl, options?.env);
  const cachePath = indexCachePath(cacheDir);

  // Check cache (unless skip-cache)
  if (!options?.skipCache && existsSync(cachePath)) {
    try {
      const stats = await stat(cachePath);
      const age = Date.now() - stats.mtimeMs;
      if (age < INDEX_TTL_MS) {
        const raw = await readFile(cachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (isValidRegistryIndex(parsed)) {
          return parsed;
        }
        // Invalid cache — fall through to fetch
        await unlink(cachePath).catch(() => {});
      }
    } catch {
      // Cache read error — fall through to fetch
    }
  }

  // Fetch from network
  try {
    const response = await fetch(registryUrl, {
      headers: { 'User-Agent': `@openreef/cli/${VERSION}` },
    });
    if (!response.ok) {
      throw new RegistryFetchError(
        `Registry returned HTTP ${response.status}: ${response.statusText}`,
      );
    }
    const data = await response.json();
    if (!isValidRegistryIndex(data)) {
      throw new RegistryFetchError(
        'Registry index has invalid format (version must be 1 with formations object)',
      );
    }

    // Write to cache
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(data, null, 2));

    return data;
  } catch (err) {
    if (err instanceof RegistryFetchError) {
      // Try stale cache fallback
      return staleCacheFallback(cachePath, err);
    }
    // Network error — try stale cache fallback
    return staleCacheFallback(
      cachePath,
      new RegistryFetchError(
        `Failed to fetch registry index: ${err instanceof Error ? err.message : String(err)}`,
        err,
      ),
    );
  }
}

async function staleCacheFallback(
  cachePath: string,
  originalError: RegistryFetchError,
): Promise<RegistryIndex> {
  if (existsSync(cachePath)) {
    try {
      const raw = await readFile(cachePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (isValidRegistryIndex(parsed)) {
        return parsed;
      }
      // Invalid stale cache — delete and throw
      await unlink(cachePath).catch(() => {});
    } catch {
      // Corrupted cache — delete and throw
      await unlink(cachePath).catch(() => {});
    }
  }
  throw originalError;
}

export function lookupFormation(
  index: RegistryIndex,
  name: string,
  version?: string,
): { entry: RegistryVersionEntry; resolvedVersion: string } {
  const formation = index.formations[name];
  if (!formation) {
    throw new RegistryFormationNotFoundError(name);
  }

  const resolvedVersion = version ?? formation.latest;
  const entry = formation.versions[resolvedVersion];
  if (!entry) {
    throw new RegistryVersionNotFoundError(name, resolvedVersion);
  }

  return { entry, resolvedVersion };
}

export async function downloadFormationTarball(
  name: string,
  version: string,
  entry: RegistryVersionEntry,
  options?: RegistryOptions,
): Promise<string> {
  const registryUrl = resolveRegistryUrl(options);
  const cacheDir = registryCacheDir(registryUrl, options?.env);
  const hasHash = !!entry.sha256;
  const disambig = hashString(`${name}:${version}`).slice(0, 8);
  const safeName = sanitizeFilenameComponent(name);
  const safeVersion = sanitizeFilenameComponent(version);
  const cacheName = `${safeName}-${safeVersion}-${disambig}.reef.tar.gz`;

  try {
    return await downloadArtifact({
      url: entry.url,
      sha256: entry.sha256,
      cacheDir: join(cacheDir, hasHash ? 'tarballs' : 'unverified'),
      cacheName,
      userAgent: `@openreef/cli/${VERSION}`,
    });
  } catch (err) {
    if (err instanceof ArtifactIntegrityError) {
      throw new RegistryIntegrityError(name, version, err.expected, err.actual);
    }
    if (err instanceof ArtifactDownloadError) {
      throw new RegistryDownloadError(
        `Failed to download ${name}@${version}: ${err.message}`,
        err.cause,
      );
    }
    throw err;
  }
}

export async function resolveFromRegistry(
  name: string,
  version?: string,
  options?: RegistryOptions,
): Promise<{ formationPath: string; tempDir: string; name: string; version: string }> {
  const index = await fetchRegistryIndex(options);
  const { entry, resolvedVersion } = lookupFormation(index, name, version);
  const tarballPath = await downloadFormationTarball(
    name,
    resolvedVersion,
    entry,
    options,
  );

  // Extract tarball to temp directory
  const tempDir = await mkdtemp(join(tmpdir(), 'reef-registry-'));
  await extract({ file: tarballPath, cwd: tempDir });

  return {
    formationPath: tempDir,
    tempDir,
    name,
    version: resolvedVersion,
  };
}
