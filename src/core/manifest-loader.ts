import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReefManifest } from '../types/manifest.js';

export class ManifestLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ManifestLoadError';
  }
}

export async function loadManifest(dir: string): Promise<ReefManifest> {
  const manifestPath = join(dir, 'reef.json');

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    throw new ManifestLoadError(
      `Cannot read reef.json: ${manifestPath}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestLoadError(
      `Invalid JSON in reef.json: ${manifestPath}`,
      err,
    );
  }

  return parsed as ReefManifest;
}
