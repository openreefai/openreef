import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest } from './manifest-loader.js';
import { validateSchema } from './schema-validator.js';
import { validateStructure } from './structural-validator.js';
import { resolveVariables } from './variable-resolver.js';
import { interpolate, buildToolsList } from './template-interpolator.js';
import { validateAgentIds } from './openclaw-paths.js';
import { loadState, listStates, computeFileHash } from './state-manager.js';
import { generateAgentsMd } from './agents-md-generator.js';
import { listFiles } from '../utils/fs.js';
import { computeMigrationPlan } from './migration-planner.js';
import { icons } from '../utils/output.js';
import chalk from 'chalk';
import type { ReefManifest } from '../types/manifest.js';
import type { FormationState } from '../types/state.js';
import type { MigrationPlan } from './migration-planner.js';

const TOKEN_RE = /\{\{\w+\}\}/;

function isBinaryBuffer(buf: Buffer): boolean {
  const check = buf.subarray(0, 8192);
  return check.includes(0);
}

function parseSets(sets?: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!sets) return result;
  for (const s of sets) {
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    result[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return result;
}

export interface DiffResult {
  plan: MigrationPlan;
  manifest: ReefManifest;
  state: FormationState;
  namespace: string;
  idMap: Map<string, string>;
  newFileHashes: Record<string, string>;
  resolvedVars: Record<string, string>;
}

export class DiffValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffValidationError';
  }
}

export async function computeFormationDiff(
  formationPath: string,
  options: { namespace?: string; set?: string[]; noEnv?: boolean; yes?: boolean },
): Promise<DiffResult> {
  // 1. Parse + validate manifest
  const manifest = await loadManifest(formationPath);

  const schemaResult = await validateSchema(manifest);
  if (!schemaResult.valid) {
    const msgs = schemaResult.issues.map((i) => i.message).join('; ');
    throw new DiffValidationError(`Schema validation failed: ${msgs}`);
  }

  const structResult = await validateStructure(manifest, formationPath);
  if (!structResult.valid) {
    const msgs = structResult.issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.message)
      .join('; ');
    throw new DiffValidationError(`Structural validation failed: ${msgs}`);
  }

  const namespace = options.namespace ?? manifest.namespace;
  const slugs = Object.keys(manifest.agents);
  const idValidation = validateAgentIds(slugs, namespace);
  if (!idValidation.valid) {
    throw new DiffValidationError(
      `Agent ID validation failed: ${idValidation.errors.join('; ')}`,
    );
  }

  // 2. Load existing state
  const existingState = await loadState(namespace, manifest.name);
  if (!existingState) {
    const allStates = await listStates();
    const byName = allStates.filter((s) => s.name === manifest.name);
    if (byName.length === 1 && byName[0].namespace !== namespace) {
      throw new DiffValidationError(
        `Formation installed under namespace "${byName[0].namespace}" but resolved namespace is "${namespace}". Use --namespace ${byName[0].namespace} to diff.`,
      );
    }
    throw new DiffValidationError(
      `Formation "${namespace}/${manifest.name}" is not installed. Use reef install instead.`,
    );
  }

  // 3. Pre-compute state awareness so the resolver doesn't prompt for known vars.
  //    Sensitive vars ($-prefixed) are already deployed — skip them entirely.
  //    Non-sensitive state vars are passed as defaults (lower priority than CLI/.env/env).
  const deployedSensitiveVars = new Set<string>();
  const stateValues: Record<string, string> = {};
  for (const name of Object.keys(manifest.variables ?? {})) {
    const stateVal = existingState.variables[name];
    if (stateVal !== undefined) {
      if (stateVal.startsWith('$')) {
        deployedSensitiveVars.add(name);
      } else {
        stateValues[name] = stateVal;
      }
    }
  }

  const { resolved: resolvedVars, missing } = await resolveVariables(
    manifest.variables ?? {},
    formationPath,
    {
      interactive: !options.yes,
      cliOverrides: parseSets(options.set),
      noEnv: options.noEnv,
      stateValues,
      skipVars: deployedSensitiveVars,
    },
  );

  const stillMissing = missing.filter(
    (name) => !deployedSensitiveVars.has(name),
  );
  if (stillMissing.length > 0) {
    throw new DiffValidationError(
      `Missing required variables: ${stillMissing.join(', ')}. Use --set KEY=VALUE or set them in .env / environment.`,
    );
  }

  resolvedVars.namespace = namespace;

  // 4. Compute file hashes for new source
  const newFileHashes: Record<string, string> = {};
  for (const [slug, agentDef] of Object.entries(manifest.agents)) {
    const agentId = idValidation.ids.get(slug)!;
    const sourceDir = join(formationPath, agentDef.source);
    try {
      const files = await listFiles(sourceDir);
      for (const relativePath of files) {
        const srcFile = join(sourceDir, relativePath);
        const rawBytes = await readFile(srcFile);
        let content: Buffer;
        const hashKey = `${agentId}:${relativePath}`;
        if (isBinaryBuffer(rawBytes)) {
          content = rawBytes;
        } else {
          const text = rawBytes.toString('utf-8');
          if (TOKEN_RE.test(text)) {
            // Check if this file references any deployed-sensitive vars
            const usesSensitiveVar = [...deployedSensitiveVars].some(
              (v) => text.includes(`{{${v}}}`),
            );
            if (usesSensitiveVar && existingState.fileHashes[hashKey]) {
              // Can't recompute hash without the real value — use stored hash.
              // If the template structure changed, user must provide the value via --set.
              newFileHashes[hashKey] = existingState.fileHashes[hashKey];
              continue;
            }
            const agentVars = {
              ...resolvedVars,
              tools: buildToolsList(agentDef.tools?.allow, manifest.dependencies?.skills),
            };
            content = Buffer.from(interpolate(text, agentVars), 'utf-8');
          } else {
            content = Buffer.from(text, 'utf-8');
          }
        }
        newFileHashes[hashKey] = computeFileHash(content);
      }
    } catch {
      // Source dir may not exist for this agent yet
    }

    // AGENTS.md hash if agent-to-agent configured
    if (manifest.agentToAgent?.[slug]?.length) {
      const agentsMd = generateAgentsMd(manifest, slug, namespace);
      const buf = Buffer.from(agentsMd, 'utf-8');
      newFileHashes[`${agentId}:AGENTS.md`] = computeFileHash(buf);
    }
  }

  // 5. Compute migration plan
  const plan = computeMigrationPlan(
    existingState,
    manifest,
    namespace,
    idValidation.ids,
    newFileHashes,
    resolvedVars,
  );

  return {
    plan,
    manifest,
    state: existingState,
    namespace,
    idMap: idValidation.ids,
    newFileHashes,
    resolvedVars,
  };
}
