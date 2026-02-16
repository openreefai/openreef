import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { loadManifest } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { validateStructure } from '../core/structural-validator.js';
import { pack as packFormation } from '../core/packer.js';
import { icons } from '../utils/output.js';
import { VERSION } from '../version.js';

export interface PublishOptions {
  token?: string;
  registry?: string;
  yes?: boolean;
}

const DEFAULT_REGISTRY_URL = 'https://tide.openreef.ai';

export async function publish(
  formationPath: string,
  options: PublishOptions,
): Promise<void> {
  const registryUrl = options.registry ?? process.env.REEF_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;

  // 1. Resolve token
  const token = options.token ?? process.env.REEF_TOKEN;
  if (!token) {
    console.error(
      `${icons.error} No Tide API token provided. Use --token or set REEF_TOKEN.\n` +
      `  Run ${chalk.cyan('reef token')} to open the dashboard and generate one.`,
    );
    process.exit(1);
  }

  // 2. Load + validate manifest
  const manifest = await loadManifest(formationPath);
  const schemaResult = await validateSchema(manifest);
  if (!schemaResult.valid) {
    console.error(`${icons.error} Schema validation failed:`);
    for (const issue of schemaResult.issues) {
      console.error(`  ${icons.error} ${issue.message}`);
    }
    process.exit(1);
  }

  const structResult = await validateStructure(manifest, formationPath);
  if (!structResult.valid) {
    console.error(`${icons.error} Structural validation failed:`);
    for (const issue of structResult.issues) {
      if (issue.severity === 'error') {
        console.error(`  ${icons.error} ${issue.message}`);
      }
    }
    process.exit(1);
  }

  // 3. Confirm
  if (!options.yes) {
    console.log(`\nAbout to publish ${chalk.cyan(`${manifest.name}@${manifest.version}`)} to ${chalk.dim(registryUrl)}.`);
    const { confirm } = await import('@inquirer/prompts');
    const ok = await confirm({ message: 'Continue?' });
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 4. Pack formation
  console.log('Packing formation...');
  const { outputPath } = await packFormation(formationPath, manifest.name, manifest.version);

  // 5. Compute tarball SHA-256
  const tarballContent = await readFile(outputPath);
  const sha256 = createHash('sha256').update(tarballContent).digest('hex');
  console.log(chalk.dim(`  SHA-256: ${sha256}`));

  // 6. Publish to Tide API
  console.log('Publishing to Tide...');
  const publishUrl = `${registryUrl}/api/formations/${encodeURIComponent(manifest.name)}/publish`;

  const formData = new FormData();
  const blob = new Blob([tarballContent], { type: 'application/gzip' });
  formData.append('tarball', blob, `${manifest.name}-${manifest.version}.reef.tar.gz`);

  let response: Response;
  try {
    response = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': `@openreef/cli/${VERSION}`,
      },
      body: formData,
    });
  } catch (err) {
    console.error(`${icons.error} Network error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return; // unreachable, but helps TypeScript
  }

  // 7. Handle responses
  if (response.ok) {
    let body: { url?: string; version?: string } = {};
    try {
      body = await response.json() as { url?: string; version?: string };
    } catch {
      // Response may not be JSON — that's fine
    }

    console.log('');
    console.log(
      `${icons.success} ${chalk.green(`Published ${manifest.name}@${manifest.version}`)}`,
    );
    if (body.url) {
      console.log(`  ${chalk.dim('URL:')} ${body.url}`);
    }
    console.log(`  ${chalk.dim('Install:')} reef install ${manifest.name}@${manifest.version}`);
    return;
  }

  // Error responses
  let errorBody = '';
  try {
    const json = await response.json() as { error?: string };
    errorBody = json.error ?? JSON.stringify(json);
  } catch {
    try {
      errorBody = await response.text();
    } catch {
      errorBody = response.statusText;
    }
  }

  switch (response.status) {
    case 401:
      console.error(`${icons.error} Authentication failed. Your token may be invalid or expired.`);
      console.error(`  Run ${chalk.cyan('reef token')} to generate a new one.`);
      break;
    case 403:
      console.error(`${icons.error} Forbidden: ${errorBody}`);
      console.error('  You may not have permission to publish this formation (not owner or name is reserved).');
      break;
    case 409:
      console.error(
        `${icons.error} Version ${manifest.version} of "${manifest.name}" already exists in the registry.`,
      );
      break;
    default:
      console.error(`${icons.error} Publish failed (HTTP ${response.status}): ${errorBody}`);
      break;
  }
  process.exit(1);
}
