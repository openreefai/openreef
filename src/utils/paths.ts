import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  // Works from both src/utils/ and dist/utils/
  return resolve(dirname(currentFile), '..', '..');
}

export function getTemplatePath(): string {
  return resolve(getPackageRoot(), 'formation-template');
}
