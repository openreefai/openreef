import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extract } from 'tar';

/**
 * If the given path looks like a tarball (.tar.gz or .tgz), extract it
 * to a temp directory and return the extracted path. Otherwise return
 * the original path unchanged.
 *
 * Caller is responsible for cleaning up the temp directory if one was created.
 */
export async function resolveFormationPath(
  inputPath: string,
): Promise<{ formationPath: string; tempDir: string | null }> {
  if (!isTarball(inputPath)) {
    return { formationPath: inputPath, tempDir: null };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'reef-install-'));
  await extract({ file: inputPath, cwd: tempDir });
  return { formationPath: tempDir, tempDir };
}

function isTarball(path: string): boolean {
  return path.endsWith('.tar.gz') || path.endsWith('.tgz') || path.endsWith('.reef.tar.gz');
}
