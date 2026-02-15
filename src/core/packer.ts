import { create } from 'tar';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

const EXCLUDE_PATTERNS = [
  '.git',
  'node_modules',
  '.env',
  '.reef',
  '.DS_Store',
];

export interface PackResult {
  outputPath: string;
  size: number;
}

export async function pack(
  formationDir: string,
  name: string,
  version: string,
  outputDir?: string,
): Promise<PackResult> {
  const filename = `${name}-${version}.reef.tar.gz`;
  const outputPath = join(outputDir ?? formationDir, filename);

  await create(
    {
      gzip: true,
      file: outputPath,
      cwd: formationDir,
      filter: (path) => {
        const parts = path.split('/');
        return !parts.some((p) => EXCLUDE_PATTERNS.includes(p));
      },
    },
    ['.'],
  );

  const info = await stat(outputPath);
  return { outputPath, size: info.size };
}
