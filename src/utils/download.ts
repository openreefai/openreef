import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { VERSION } from '../version.js';

export interface ArtifactDownloadOptions {
  url: string;
  sha256?: string;
  cacheDir: string;
  cacheName: string;
  userAgent: string;
}

export class ArtifactDownloadError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'ArtifactDownloadError';
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(`Integrity check failed: expected sha256 ${expected}, got ${actual}`);
    this.name = 'ArtifactIntegrityError';
  }
}

function validateUrlScheme(url: string): void {
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new ArtifactDownloadError(
      `Invalid URL scheme: only https:// and http:// are allowed, got "${url}"`,
    );
  }
}

export async function downloadArtifact(options: ArtifactDownloadOptions): Promise<string> {
  const { url, sha256, cacheDir, cacheName, userAgent } = options;
  const hasHash = !!sha256;
  const subdir = hasHash ? 'verified' : 'unverified';
  const cachePath = join(cacheDir, subdir, cacheName);

  // Verified artifacts: reuse from cache after re-checking hash
  if (hasHash && existsSync(cachePath)) {
    const cached = await readFile(cachePath);
    const cachedHash = createHash('sha256').update(cached).digest('hex');
    if (cachedHash === sha256) {
      return cachePath;
    }
    await unlink(cachePath).catch(() => {});
  }

  if (!hasHash) {
    console.warn(`WARNING: No integrity hash — artifact is UNVERIFIED`);
  }

  validateUrlScheme(url);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
    });
  } catch (err) {
    throw new ArtifactDownloadError(
      `Failed to download: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!response.ok) {
    throw new ArtifactDownloadError(
      `Download returned HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Verify SHA-256 if present
  if (sha256) {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual !== sha256) {
      throw new ArtifactIntegrityError(sha256, actual);
    }
  }

  // Write to cache
  const parentDir = join(cacheDir, subdir);
  await mkdir(parentDir, { recursive: true });
  await writeFile(cachePath, buffer);

  return cachePath;
}
