import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { loadManifest } from '../core/manifest-loader.js';
import { validate } from './validate.js';
import { pack as packFormation } from '../core/packer.js';
import { icons } from '../utils/output.js';

export interface PackOptions {
  output?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function pack(
  path: string,
  options: PackOptions = {},
): Promise<void> {
  const formationDir = resolve(path);

  // Validate first
  const result = await validate(formationDir, { quiet: true });
  if (!result.valid) {
    console.error(`${icons.error} Formation has validation errors. Fix them before packing.\n`);
    // Print errors
    for (const issue of result.issues) {
      if (issue.severity === 'error') {
        console.error(`  ${icons.error} ${issue.message}`);
      }
    }
    process.exit(1);
  }

  const manifest = await loadManifest(formationDir);

  const spinner = ora('Packing formation...').start();

  try {
    const outputDir = options.output ? resolve(options.output) : undefined;
    const { outputPath, size } = await packFormation(
      formationDir,
      manifest.name,
      manifest.version,
      outputDir,
    );

    spinner.succeed('Formation packed');
    console.log(`  ${chalk.dim('Output:')} ${chalk.cyan(outputPath)}`);
    console.log(`  ${chalk.dim('Size:')}   ${formatSize(size)}`);
  } catch (err) {
    spinner.fail('Failed to pack formation');
    throw err;
  }
}
