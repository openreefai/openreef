import { resolve, relative, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import chalk from 'chalk';
import { copyDir } from '../utils/fs.js';
import { icons } from '../utils/output.js';
import {
  resolveFormationState,
  FormationNotFoundError,
  AmbiguousFormationError,
} from '../utils/identifiers.js';

export interface ExportOptions {
  output?: string;
  force?: boolean;
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith('..') && !resolve(parent, rel).includes('..') && rel !== '';
}

export async function exportFormation(
  identifier: string,
  options: ExportOptions,
): Promise<void> {
  // 1. Resolve formation state
  let state;
  try {
    state = await resolveFormationState(identifier);
  } catch (err) {
    if (err instanceof FormationNotFoundError) {
      console.error(`${icons.error} ${err.message}`);
      process.exit(1);
    }
    if (err instanceof AmbiguousFormationError) {
      console.error(
        `${icons.error} Multiple formations named "${err.message.split('"')[1]}" found:`,
      );
      for (const m of err.matches) {
        console.error(`  - ${m.namespace}/${m.name}`);
      }
      console.error('  Specify the full namespace/name.');
      process.exit(1);
    }
    throw err;
  }

  // 2. Validate sourcePath
  const sourcePath = state.sourcePath;
  if (!sourcePath || !existsSync(sourcePath)) {
    console.error(
      `${icons.error} Formation source is no longer available. Try reinstalling.`,
    );
    process.exit(1);
  }

  // 3. Determine output dir
  const outputDir = resolve(options.output ?? `./${state.name}`);
  const resolvedSource = resolve(normalize(sourcePath));
  const resolvedOutput = resolve(normalize(outputDir));

  // 4. Path overlap guards
  if (resolvedSource === resolvedOutput) {
    console.error(`${icons.error} Output directory is the same as the source directory.`);
    process.exit(1);
  }

  if (isInsidePath(resolvedSource, resolvedOutput)) {
    console.error(
      `${icons.error} Output directory is inside the source directory (would cause infinite recursion).`,
    );
    process.exit(1);
  }

  if (options.force && isInsidePath(resolvedOutput, resolvedSource)) {
    console.error(
      `${icons.error} Source directory is inside the output directory (would be deleted by --force).`,
    );
    process.exit(1);
  }

  // 5. Check existing output
  if (existsSync(outputDir) && !options.force) {
    console.error(
      `${icons.error} Output directory already exists: ${outputDir}`,
    );
    console.error(`  Use ${chalk.cyan('--force')} to overwrite.`);
    process.exit(1);
  }

  // 6. Force overwrite
  if (options.force && existsSync(outputDir)) {
    await rm(outputDir, { recursive: true, force: true });
  }

  // 7. Copy
  await copyDir(sourcePath, outputDir);

  console.log(
    `${icons.success} ${chalk.green(`Formation exported to ${outputDir}`)}`,
  );
}
