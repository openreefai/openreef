import { readdir, stat, mkdir, copyFile, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function copyDir(
  src: string,
  dest: string,
  exclude?: string[],
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude?.includes(entry.name)) continue;

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, exclude);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(relative(dir, fullPath));
      }
    }
  }

  await walk(dir);
  return results.sort();
}

export async function scanVariableTokens(dir: string): Promise<string[]> {
  const tokens = new Set<string>();
  const files = await listFiles(dir);
  const pattern = /\{\{(\w+)\}\}/g;

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const content = await readFile(join(dir, file), 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      tokens.add(match[1]);
    }
  }

  return [...tokens].sort();
}
