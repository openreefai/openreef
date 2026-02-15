import { resolve, join } from 'node:path';
import { writeFile, readFile, access } from 'node:fs/promises';
import chalk from 'chalk';
import { copyDir } from '../utils/fs.js';
import { getTemplatePath } from '../utils/paths.js';
import { icons } from '../utils/output.js';
import type { ReefManifest, Variable } from '../types/manifest.js';

export interface InitOptions {
  name?: string;
  namespace?: string;
  type?: 'solo' | 'shoal' | 'school';
  yes?: boolean;
}

function generateEnvExample(variables: Record<string, Variable>): string {
  const lines: string[] = ['# OpenReef Formation Variables'];

  for (const [name, config] of Object.entries(variables)) {
    if (config.description) {
      lines.push(`# ${config.description}`);
    }
    if (config.sensitive) {
      lines.push(`${name}=`);
    } else if (config.default !== undefined) {
      lines.push(`${name}="${String(config.default)}"`);
    } else {
      lines.push(`${name}=`);
    }
  }

  return lines.join('\n') + '\n';
}

export async function init(
  nameArg: string | undefined,
  options: InitOptions = {},
): Promise<void> {
  const name = nameArg ?? options.name ?? 'my-formation';
  const namespace = options.namespace ?? name;
  const type = options.type ?? 'shoal';

  const targetDir = resolve(name);

  // Check if directory already exists
  try {
    await access(targetDir);
    console.error(
      `${icons.error} Directory "${name}" already exists. Choose a different name or remove it first.`,
    );
    process.exit(1);
  } catch {
    // Directory doesn't exist — good
  }

  // Copy template, excluding .env.example (we generate it fresh)
  const templateDir = getTemplatePath();
  await copyDir(templateDir, targetDir, ['.env.example']);

  // Read and update reef.json
  const manifestPath = join(targetDir, 'reef.json');
  const raw = await readFile(manifestPath, 'utf-8');
  const manifest: ReefManifest = JSON.parse(raw);

  manifest.name = name;
  manifest.namespace = namespace;
  manifest.type = type;

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // Generate .env.example from variables
  if (manifest.variables && Object.keys(manifest.variables).length > 0) {
    const envContent = generateEnvExample(manifest.variables);
    await writeFile(join(targetDir, '.env.example'), envContent);
  }

  console.log(`${icons.success} Formation ${chalk.bold(name)} created!\n`);
  console.log('Next steps:');
  console.log(`  ${chalk.cyan(`cd ${name}`)}`);
  console.log(`  ${chalk.dim('# edit .env and customize reef.json')}`);
  console.log(`  ${chalk.cyan('reef validate .')}`);
}
