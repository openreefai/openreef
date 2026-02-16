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

/** Response from GET /api/formations/:name */
export interface TideFormationDetail {
  name: string;
  description?: string;
  type?: string;
  latest_version?: string;
  total_downloads?: number;
  owner_id?: string;
}

/** Response from GET /api/formations/:name/:version */
export interface TideVersionDetail {
  name: string;
  version: string;
  tarball_sha256?: string;
  sha256?: string;
  download_url?: string;
  readme?: string;
}

/** Response from GET /api/formations/:name/resolve?range=... */
export interface TideResolveResult {
  version: string;
  tarball_sha256?: string;
  sha256?: string;
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

const DEFAULT_REGISTRY_URL = 'https://tide.openreef.ai';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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

function formationCachePath(cacheDir: string, name: string): string {
  const safeName = sanitizeFilenameComponent(name);
  return join(cacheDir, 'formations', `${safeName}.json`);
}

// ── Tide API lookups ──

/**
 * Look up a formation from the Tide API.
 * If version is provided, fetches that specific version detail.
 * If version is omitted, fetches the formation detail (which includes latest_version).
 */
export async function lookupFormation(
  name: string,
  version?: string,
  options?: RegistryOptions,
): Promise<{ entry: RegistryVersionEntry; resolvedVersion: string }> {
  const registryUrl = resolveRegistryUrl(options);
  validateUrlScheme(registryUrl, 'registry');

  const cacheDir = registryCacheDir(registryUrl, options?.env);

  // If a semver range is provided (contains special chars), use the resolve endpoint
  if (version && /[~^>=<| ]/.test(version)) {
    return resolveRange(name, version, registryUrl, cacheDir, options);
  }

  if (version && version !== 'latest') {
    // Fetch specific version
    return fetchVersionDetail(name, version, registryUrl, cacheDir, options);
  }

  // No version or "latest" — fetch formation detail to get latest_version
  return fetchLatestVersion(name, registryUrl, cacheDir, options);
}

async function resolveRange(
  name: string,
  range: string,
  registryUrl: string,
  cacheDir: string,
  options?: RegistryOptions,
): Promise<{ entry: RegistryVersionEntry; resolvedVersion: string }> {
  const url = `${registryUrl}/api/formations/${encodeURIComponent(name)}/resolve?range=${encodeURIComponent(range)}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': `@openreef/cli/${VERSION}` },
    });

    if (response.status === 404) {
      const body = await response.text();
      if (body.includes('No version satisfies') || body.includes('No published versions')) {
        throw new RegistryVersionNotFoundError(name, range);
      }
      throw new RegistryFormationNotFoundError(name);
    }

    if (!response.ok) {
      throw new RegistryFetchError(
        `Registry returned HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json() as TideResolveResult;
    const downloadUrl = `${registryUrl}/api/formations/${encodeURIComponent(name)}/${encodeURIComponent(data.version)}/download`;

    return {
      entry: { url: downloadUrl, sha256: data.tarball_sha256 ?? data.sha256 },
      resolvedVersion: data.version,
    };
  } catch (err) {
    if (
      err instanceof RegistryFormationNotFoundError ||
      err instanceof RegistryVersionNotFoundError ||
      err instanceof RegistryFetchError
    ) {
      throw err;
    }
    throw new RegistryFetchError(
      `Failed to resolve range "${range}" for "${name}": ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

async function fetchVersionDetail(
  name: string,
  version: string,
  registryUrl: string,
  cacheDir: string,
  options?: RegistryOptions,
): Promise<{ entry: RegistryVersionEntry; resolvedVersion: string }> {
  // Check cache first
  const cachePath = join(cacheDir, 'versions', `${sanitizeFilenameComponent(name)}-${sanitizeFilenameComponent(version)}.json`);

  if (!options?.skipCache && existsSync(cachePath)) {
    try {
      const stats = await stat(cachePath);
      const age = Date.now() - stats.mtimeMs;
      if (age < CACHE_TTL_MS) {
        const raw = await readFile(cachePath, 'utf-8');
        const cached = JSON.parse(raw) as { entry: RegistryVersionEntry; resolvedVersion: string };
        return cached;
      }
    } catch {
      // Cache read error — fall through to fetch
    }
  }

  const url = `${registryUrl}/api/formations/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': `@openreef/cli/${VERSION}` },
    });

    if (response.status === 404) {
      // Could be formation not found or version not found — try to distinguish
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (body.error?.toLowerCase().includes('formation')) {
        throw new RegistryFormationNotFoundError(name);
      }
      throw new RegistryVersionNotFoundError(name, version);
    }

    if (!response.ok) {
      throw new RegistryFetchError(
        `Registry returned HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json() as TideVersionDetail;
    const downloadUrl = data.download_url ?? `${registryUrl}/api/formations/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`;

    const result = {
      entry: { url: downloadUrl, sha256: data.tarball_sha256 ?? data.sha256 },
      resolvedVersion: data.version,
    };

    // Write to cache
    await mkdir(join(cacheDir, 'versions'), { recursive: true });
    await writeFile(cachePath, JSON.stringify(result, null, 2));

    return result;
  } catch (err) {
    if (
      err instanceof RegistryFormationNotFoundError ||
      err instanceof RegistryVersionNotFoundError ||
      err instanceof RegistryFetchError
    ) {
      // Try stale cache fallback
      return versionCacheFallback(cachePath, err);
    }
    const fetchErr = new RegistryFetchError(
      `Failed to fetch version detail for "${name}@${version}": ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
    return versionCacheFallback(cachePath, fetchErr);
  }
}

async function fetchLatestVersion(
  name: string,
  registryUrl: string,
  cacheDir: string,
  options?: RegistryOptions,
): Promise<{ entry: RegistryVersionEntry; resolvedVersion: string }> {
  // Check cache first
  const cachePath = formationCachePath(cacheDir, name);

  if (!options?.skipCache && existsSync(cachePath)) {
    try {
      const stats = await stat(cachePath);
      const age = Date.now() - stats.mtimeMs;
      if (age < CACHE_TTL_MS) {
        const raw = await readFile(cachePath, 'utf-8');
        const cached = JSON.parse(raw) as { entry: RegistryVersionEntry; resolvedVersion: string };
        return cached;
      }
    } catch {
      // Cache read error — fall through to fetch
    }
  }

  const url = `${registryUrl}/api/formations/${encodeURIComponent(name)}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': `@openreef/cli/${VERSION}` },
    });

    if (response.status === 404) {
      throw new RegistryFormationNotFoundError(name);
    }

    if (!response.ok) {
      throw new RegistryFetchError(
        `Registry returned HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json() as TideFormationDetail;
    if (!data.latest_version) {
      throw new RegistryVersionNotFoundError(name, 'latest');
    }

    // Fetch version detail to get the integrity hash (tarball_sha256)
    const result = await fetchVersionDetail(name, data.latest_version, registryUrl, cacheDir, options);

    // Write to formation cache so future "latest" lookups are fast
    await mkdir(join(cacheDir, 'formations'), { recursive: true });
    await writeFile(cachePath, JSON.stringify(result, null, 2));

    return result;
  } catch (err) {
    if (
      err instanceof RegistryFormationNotFoundError ||
      err instanceof RegistryVersionNotFoundError ||
      err instanceof RegistryFetchError
    ) {
      return formationCacheFallback(cachePath, err);
    }
    const fetchErr = new RegistryFetchError(
      `Failed to fetch formation "${name}": ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
    return formationCacheFallback(cachePath, fetchErr);
  }
}

async function versionCacheFallback(
  cachePath: string,
  originalError: Error,
): Promise<{ entry: RegistryVersionEntry; resolvedVersion: string }> {
  if (existsSync(cachePath)) {
    try {
      const raw = await readFile(cachePath, 'utf-8');
      const cached = JSON.parse(raw) as { entry: RegistryVersionEntry; resolvedVersion: string };
      if (cached.entry && cached.resolvedVersion) {
        return cached;
      }
      await unlink(cachePath).catch(() => {});
    } catch {
      await unlink(cachePath).catch(() => {});
    }
  }
  throw originalError;
}

const formationCacheFallback = versionCacheFallback;

// ── Download ──

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

// ── Main resolution entry point ──

export async function resolveFromRegistry(
  name: string,
  version?: string,
  options?: RegistryOptions,
): Promise<{ formationPath: string; tempDir: string; name: string; version: string }> {
  const { entry, resolvedVersion } = await lookupFormation(name, version, options);
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

// ── Legacy compat: fetchRegistryIndex ──
// Kept for backward compatibility with tests. In the new API model,
// we don't fetch a monolithic index. Instead, we query per-formation endpoints.

export async function fetchRegistryIndex(
  options?: RegistryOptions,
): Promise<RegistryIndex> {
  const registryUrl = resolveRegistryUrl(options);
  validateUrlScheme(registryUrl, 'registry');

  const cacheDir = registryCacheDir(registryUrl, options?.env);
  const cachePath = join(cacheDir, 'registry-index.json');

  // Check cache (unless skip-cache)
  if (!options?.skipCache && existsSync(cachePath)) {
    try {
      const stats = await stat(cachePath);
      const age = Date.now() - stats.mtimeMs;
      if (age < CACHE_TTL_MS) {
        const raw = await readFile(cachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (isValidRegistryIndex(parsed)) {
          return parsed;
        }
        await unlink(cachePath).catch(() => {});
      }
    } catch {
      // Cache read error — fall through to fetch
    }
  }

  // Fetch from network (try the old-style index URL in case it exists)
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
      return staleCacheFallback(cachePath, err);
    }
    return staleCacheFallback(
      cachePath,
      new RegistryFetchError(
        `Failed to fetch registry index: ${err instanceof Error ? err.message : String(err)}`,
        err,
      ),
    );
  }
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
      await unlink(cachePath).catch(() => {});
    } catch {
      await unlink(cachePath).catch(() => {});
    }
  }
  throw originalError;
}
