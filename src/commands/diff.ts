import { rm } from 'node:fs/promises';
import chalk from 'chalk';
import { resolveFormationPath } from '../utils/tarball.js';
import { computeFormationDiff, DiffValidationError } from '../core/diff-engine.js';
import { displayMigrationPlan } from '../utils/plan-display.js';
import { icons } from '../utils/output.js';

export interface DiffOptions {
  namespace?: string;
  set?: string[];
  noEnv?: boolean;
  registryUrl?: string;
  skipCache?: boolean;
}

export async function diff(
  inputPath: string,
  options: DiffOptions,
): Promise<void> {
  const { formationPath, tempDir } = await resolveFormationPath(
    inputPath,
    { registryUrl: options.registryUrl, skipCache: options.skipCache },
  );

  try {
    const result = await computeFormationDiff(formationPath, {
      namespace: options.namespace,
      set: options.set,
      noEnv: options.noEnv,
      yes: false,
    });

    if (result.plan.isEmpty) {
      console.log(
        `${icons.success} ${chalk.green('No changes detected.')}`,
      );
      return;
    }

    displayMigrationPlan(result.plan, result.namespace, result.manifest.name);
  } catch (err) {
    if (err instanceof DiffValidationError) {
      console.error(`${icons.error} ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
