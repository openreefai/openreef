import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { loadManifest } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { validateStructure } from '../core/structural-validator.js';
import { pack as packFormation } from '../core/packer.js';
import {
  getRegistryIndex,
  createDraftRelease,
  uploadReleaseAsset,
  publishRelease,
  deleteRelease,
  updateRegistryIndex,
  GitHubConflictError,
  PublishRollbackError,
} from '../core/github-api.js';
import { compareSemver, parseSemver } from '../utils/semver.js';
import { icons } from '../utils/output.js';
import type { RegistryIndex } from '../core/registry.js';

export interface PublishOptions {
  token?: string;
  owner?: string;
  repo?: string;
  yes?: boolean;
}

export async function publish(
  formationPath: string,
  options: PublishOptions,
): Promise<void> {
  // 1. Resolve token
  const token = options.token ?? process.env.REEF_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error(
      `${icons.error} No GitHub token provided. Use --token, REEF_GITHUB_TOKEN, or GITHUB_TOKEN.`,
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

  const apiOptions = { token, owner: options.owner, repo: options.repo };

  // 3. Check version conflict
  const existingIndex = await getRegistryIndex(apiOptions);
  if (existingIndex) {
    const formation = existingIndex.content.formations[manifest.name];
    if (formation?.versions[manifest.version]) {
      console.error(
        `${icons.error} Version ${manifest.version} of "${manifest.name}" already exists in the registry.`,
      );
      process.exit(1);
    }
  }

  // 4. Confirm
  if (!options.yes) {
    console.log(`\nAbout to publish ${chalk.cyan(`${manifest.name}@${manifest.version}`)} to the registry.`);
    const { confirm } = await import('@inquirer/prompts');
    const ok = await confirm({ message: 'Continue?' });
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 5. Pack formation
  console.log('Packing formation...');
  const { outputPath } = await packFormation(formationPath, manifest.name, manifest.version);

  // 6. Compute tarball SHA-256
  const tarballContent = await readFile(outputPath);
  const sha256 = createHash('sha256').update(tarballContent).digest('hex');

  // 7. Atomic publish
  const tag = `${manifest.name}@${manifest.version}`;
  console.log('Creating draft release...');
  const { releaseId } = await createDraftRelease(
    tag,
    `${manifest.name} v${manifest.version}`,
    manifest.description ?? '',
    apiOptions,
  );

  console.log('Uploading tarball...');
  const { assetUrl } = await uploadReleaseAsset(releaseId, outputPath, apiOptions);

  // 8. Update registry index
  console.log('Updating registry index...');
  const currentIndex = existingIndex ?? {
    content: { version: 1, formations: {} } as RegistryIndex,
    sha: '',
  };
  const index = currentIndex.content;

  if (!index.formations[manifest.name]) {
    index.formations[manifest.name] = {
      description: manifest.description,
      latest: manifest.version,
      versions: {},
    };
  }

  const formation = index.formations[manifest.name];
  formation.versions[manifest.version] = {
    url: assetUrl,
    sha256,
  };

  // Update latest: only if non-prerelease and semver-greater
  const isPrerelease = manifest.version.includes('-');
  if (!isPrerelease) {
    let shouldUpdateLatest = false;
    if (!formation.latest) {
      shouldUpdateLatest = true;
    } else {
      // Validate current latest before comparing
      try {
        parseSemver(formation.latest);
        const isCurrentPrerelease = formation.latest.includes('-');
        if (isCurrentPrerelease) {
          shouldUpdateLatest = true;
        } else {
          shouldUpdateLatest = compareSemver(manifest.version, formation.latest) > 0;
        }
      } catch {
        // Malformed current latest — treat as no valid latest
        shouldUpdateLatest = true;
      }
    }
    if (shouldUpdateLatest) {
      formation.latest = manifest.version;
    }
  } else {
    console.log(chalk.dim(`  Prerelease version — "latest" not updated.`));
  }

  try {
    await updateRegistryIndex(
      index,
      existingIndex?.sha,
      `publish ${tag}`,
      apiOptions,
    );
  } catch (err) {
    // Rollback: delete draft release
    console.error('Index update failed — rolling back draft release...');
    try {
      await deleteRelease(releaseId, apiOptions);
      console.error('Draft release cleaned up.');
    } catch (rollbackErr) {
      const { owner, repo } = {
        owner: apiOptions.owner ?? 'openreefai',
        repo: apiOptions.repo ?? 'formations',
      };
      throw new PublishRollbackError(
        `Failed to clean up draft release ${tag} (ID: ${releaseId}). Delete it manually at https://github.com/${owner}/${repo}/releases/tag/${tag}`,
        err instanceof Error ? err : new Error(String(err)),
        releaseId,
        tag,
      );
    }
    throw err;
  }

  // 9. Finalize release
  console.log('Publishing release...');
  await publishRelease(releaseId, apiOptions);

  console.log('');
  console.log(
    `${icons.success} ${chalk.green(`Published ${manifest.name}@${manifest.version}`)}`,
  );
  console.log(`  Install: reef install ${manifest.name}@${manifest.version}`);
}
