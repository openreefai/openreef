import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { resolveFormationPath } from '../utils/tarball.js';
import { loadManifest } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { validateStructure } from '../core/structural-validator.js';
import { resolveVariables } from '../core/variable-resolver.js';
import { interpolate } from '../core/template-interpolator.js';
import {
  resolveWorkspacePath,
  resolveGatewayUrl,
  resolveStateDir,
  resolveAgentStatePaths,
  validateAgentIds,
} from '../core/openclaw-paths.js';
import {
  readConfig,
  writeConfig,
  addAgentEntry,
  removeAgentEntry,
  addBinding,
  removeBinding,
  setAgentToAgent,
  removeAgentToAgent,
} from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth } from '../core/gateway-client.js';
import {
  loadState,
  saveState,
  listStates,
  computeFileHash,
} from '../core/state-manager.js';
import { generateAgentsMd } from '../core/agents-md-generator.js';
import { listFiles } from '../utils/fs.js';
import { computeMigrationPlan } from '../core/migration-planner.js';
import { icons, header, label, value, table } from '../utils/output.js';
import type { ReefManifest } from '../types/manifest.js';
import type {
  FormationState,
  AgentState,
  CronJobState,
  OpenClawBinding,
} from '../types/state.js';

export interface UpdateOptions {
  set?: string[];
  namespace?: string;
  yes?: boolean;
  noEnv?: boolean;
  dryRun?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
}

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

export async function update(
  inputPath: string,
  options: UpdateOptions,
): Promise<void> {
  // Resolve tarball to directory if needed
  const { formationPath, tempDir } = await resolveFormationPath(inputPath);
  try {
    await _update(formationPath, options);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function _update(
  formationPath: string,
  options: UpdateOptions,
): Promise<void> {
  // 1. Parse + validate manifest
  const spinner = ora('Loading formation...').start();

  let manifest: ReefManifest;
  try {
    manifest = await loadManifest(formationPath);
  } catch (err) {
    spinner.fail('Failed to load formation');
    throw err;
  }

  const schemaResult = await validateSchema(manifest);
  if (!schemaResult.valid) {
    spinner.fail('Schema validation failed');
    for (const issue of schemaResult.issues) {
      console.error(`  ${icons.error} ${issue.message}`);
    }
    process.exit(1);
  }

  const structResult = await validateStructure(manifest, formationPath);
  if (!structResult.valid) {
    spinner.fail('Structural validation failed');
    for (const issue of structResult.issues) {
      if (issue.severity === 'error') {
        console.error(`  ${icons.error} ${issue.message}`);
      }
    }
    process.exit(1);
  }

  const namespace = options.namespace ?? manifest.namespace;
  const slugs = Object.keys(manifest.agents);
  const idValidation = validateAgentIds(slugs, namespace);
  if (!idValidation.valid) {
    spinner.fail('Agent ID validation failed');
    for (const error of idValidation.errors) {
      console.error(`  ${icons.error} ${error}`);
    }
    process.exit(1);
  }

  spinner.succeed('Formation loaded and validated');

  // 2. Load existing state
  const existingState = await loadState(namespace, manifest.name);
  if (!existingState) {
    // Formation not found under resolved namespace — check if it exists
    // under a different namespace to give an actionable error message
    const allStates = await listStates();
    const byName = allStates.filter((s) => s.name === manifest.name);
    if (byName.length === 1 && byName[0].namespace !== namespace) {
      console.error(
        `${icons.error} Formation installed under namespace "${byName[0].namespace}" but resolved namespace is "${namespace}".`,
      );
      console.error(
        `  Use ${chalk.cyan(`--namespace ${byName[0].namespace}`)} to update, or uninstall and reinstall under the new namespace.`,
      );
      process.exit(1);
    }
    console.error(
      `${icons.error} Formation "${namespace}/${manifest.name}" is not installed. Use ${chalk.cyan('reef install')} instead.`,
    );
    process.exit(1);
  }

  // 3. Resolve variables
  const { resolved: resolvedVars, missing } = await resolveVariables(
    manifest.variables ?? {},
    formationPath,
    {
      interactive: !options.yes,
      cliOverrides: parseSets(options.set),
      noEnv: options.noEnv,
    },
  );

  // Fallback: merge non-sensitive values from prior state (low priority).
  // Sensitive vars are stored as "$NAME" placeholders — never use those as fallback.
  for (const name of Object.keys(manifest.variables ?? {})) {
    if (resolvedVars[name] !== undefined) continue;
    const stateVal = existingState.variables[name];
    if (stateVal !== undefined && !stateVal.startsWith('$')) {
      resolvedVars[name] = stateVal;
    }
  }

  // Re-filter missing after state fallback
  const stillMissing = missing.filter((name) => resolvedVars[name] === undefined);

  if (stillMissing.length > 0) {
    console.error(
      `${icons.error} Missing required variables: ${stillMissing.join(', ')}`,
    );
    console.error(
      '  Use --set KEY=VALUE or set them in .env / environment.',
    );
    process.exit(1);
  }

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
        if (isBinaryBuffer(rawBytes)) {
          content = rawBytes;
        } else {
          const text = rawBytes.toString('utf-8');
          content = Buffer.from(
            TOKEN_RE.test(text) ? interpolate(text, resolvedVars) : text,
            'utf-8',
          );
        }
        newFileHashes[`${agentId}:${relativePath}`] = computeFileHash(content);
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
  );

  if (plan.isEmpty) {
    console.log(
      `${icons.success} ${chalk.green('Already up to date.')}`,
    );
    return;
  }

  // 6. Print migration plan
  console.log('');
  const versionStr = plan.versionChange
    ? ` v${plan.versionChange.from} → v${plan.versionChange.to}`
    : '';
  console.log(
    header(`Migration Plan: ${namespace}/${manifest.name}${versionStr}`),
  );
  console.log('');

  // Agents
  console.log(label('Agents:'));
  for (const a of plan.agents) {
    switch (a.type) {
      case 'add':
        console.log(`  ${chalk.green('+')} ${a.slug} (add)`);
        break;
      case 'remove':
        console.log(`  ${chalk.red('-')} ${a.slug} (remove)`);
        break;
      case 'update':
        console.log(
          `  ${chalk.yellow('~')} ${a.slug} (${a.changedFiles?.length} files changed)`,
        );
        break;
      case 'unchanged':
        console.log(`  ${chalk.dim('=')} ${a.slug} (unchanged)`);
        break;
    }
  }

  // Bindings
  if (plan.bindings.length > 0) {
    console.log('');
    console.log(label('Bindings:'));
    for (const b of plan.bindings) {
      const prefix = b.type === 'add' ? chalk.green('+') : chalk.red('-');
      console.log(
        `  ${prefix} ${b.binding.match.channel} → ${b.binding.agentId}`,
      );
    }
  }

  // Cron
  if (plan.cron.length > 0) {
    console.log('');
    console.log(label('Cron Jobs:'));
    for (const c of plan.cron) {
      switch (c.type) {
        case 'add':
          console.log(`  ${chalk.green('+')} ${c.name}`);
          break;
        case 'remove':
          console.log(`  ${chalk.red('-')} ${c.name}`);
          break;
        case 'update':
          console.log(`  ${chalk.yellow('~')} ${c.name}`);
          break;
      }
    }
  }

  // A2a
  if (plan.a2a.length > 0) {
    console.log('');
    console.log(label('Agent-to-Agent:'));
    for (const edge of plan.a2a) {
      const prefix =
        edge.type === 'add'
          ? chalk.green('+')
          : edge.type === 'remove'
            ? chalk.red('-')
            : chalk.yellow('~');
      console.log(`  ${prefix} ${edge.from} → ${edge.to}`);
    }
  }

  // 7. Dry run
  if (options.dryRun) {
    console.log('');
    console.log(label('Dry run — no changes applied.'));
    return;
  }

  // 8. Confirm
  if (!options.yes) {
    console.log('');
    const { confirm } = await import('@inquirer/prompts');
    const proceed = await confirm({
      message: 'Apply this migration?',
    });
    if (!proceed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 9. Execute migration
  const deploySpinner = ora('Applying migration...').start();

  const agentStates: Record<string, AgentState> = { ...existingState.agents };
  const fileHashes: Record<string, string> = { ...existingState.fileHashes };
  const cronJobStates: CronJobState[] = [...existingState.cronJobs];
  const openClawBindings: OpenClawBinding[] = [...existingState.bindings];

  // 9a. Remove dropped agents
  for (const change of plan.agents.filter((a) => a.type === 'remove')) {
    const agent = existingState.agents[change.slug];
    if (!agent) continue;

    // Try Gateway cleanup
    try {
      const { config: gwConfig } = await readConfig();
      const gwUrl =
        options.gatewayUrl ?? resolveGatewayUrl(gwConfig, process.env);
      const gwAuth = resolveGatewayAuth({
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        gatewayPassword: options.gatewayPassword,
        config: gwConfig,
      });
      const gw = new GatewayClient({ url: gwUrl, ...gwAuth });
      await gw.connect();
      try {
        await gw.call('agents.delete', { agentId: agent.id });
      } catch { /* Agent may not exist in Gateway */ }
      gw.close();
    } catch { /* Gateway unreachable */ }

    // Delete workspace
    try {
      await rm(agent.workspace, { recursive: true, force: true });
    } catch { /* Already gone */ }

    // Clean agent state paths
    const resolvedStateDir = resolve(resolveStateDir());
    const statePaths = resolveAgentStatePaths(agent.id);
    for (const p of statePaths) {
      if (!existsSync(p)) continue;
      const resolvedPath = resolve(p);
      const rel = relative(resolvedStateDir, resolvedPath);
      if (rel.startsWith('..') || resolve(resolvedStateDir, rel) !== resolvedPath) continue;
      try {
        await rm(p, { recursive: true, force: true });
      } catch { /* Fine */ }
    }

    // Remove from state
    delete agentStates[change.slug];
    // Remove file hashes for this agent
    for (const key of Object.keys(fileHashes)) {
      if (key.startsWith(`${agent.id}:`)) {
        delete fileHashes[key];
      }
    }
  }

  // 9b. Deploy new/changed workspace files
  for (const change of plan.agents.filter(
    (a) => a.type === 'add' || a.type === 'update',
  )) {
    const agentDef = manifest.agents[change.slug];
    const agentId = change.agentId;
    const workspacePath = resolveWorkspacePath(agentId);
    await mkdir(workspacePath, { recursive: true });

    const sourceDir = join(formationPath, agentDef.source);
    const files = await listFiles(sourceDir);
    const deployedFiles: string[] = [];

    for (const relativePath of files) {
      const srcFile = join(sourceDir, relativePath);
      const destPath = join(workspacePath, relativePath);
      await mkdir(dirname(destPath), { recursive: true });

      const rawBytes = await readFile(srcFile);

      if (isBinaryBuffer(rawBytes)) {
        const hash = computeFileHash(rawBytes);
        const existingHash = fileHashes[`${agentId}:${relativePath}`];
        if (existingHash !== hash) {
          await writeFile(destPath, rawBytes);
        }
        fileHashes[`${agentId}:${relativePath}`] = hash;
        deployedFiles.push(relativePath);
        continue;
      }

      let content = rawBytes.toString('utf-8');
      if (TOKEN_RE.test(content)) {
        content = interpolate(content, resolvedVars);
      }
      const written = Buffer.from(content, 'utf-8');
      const hash = computeFileHash(written);
      const existingHash = fileHashes[`${agentId}:${relativePath}`];
      if (existingHash !== hash) {
        await writeFile(destPath, written);
      }
      fileHashes[`${agentId}:${relativePath}`] = hash;
      deployedFiles.push(relativePath);
    }

    // Generate AGENTS.md if needed
    if (manifest.agentToAgent?.[change.slug]?.length) {
      const agentsMd = generateAgentsMd(manifest, change.slug, namespace);
      const buf = Buffer.from(agentsMd, 'utf-8');
      await writeFile(join(workspacePath, 'AGENTS.md'), buf);
      fileHashes[`${agentId}:AGENTS.md`] = computeFileHash(buf);
      deployedFiles.push('AGENTS.md');
    }

    agentStates[change.slug] = {
      id: agentId,
      slug: change.slug,
      workspace: workspacePath,
      files: deployedFiles,
      model: agentDef.model,
    };
  }

  // 9c. Update config
  deploySpinner.text = 'Patching config...';
  let patchedConfig = (await readConfig()).config;

  // Remove dropped agents and bindings from config
  for (const change of plan.agents.filter((a) => a.type === 'remove')) {
    patchedConfig = removeAgentEntry(patchedConfig, change.agentId);
  }
  for (const b of plan.bindings.filter((b) => b.type === 'remove')) {
    patchedConfig = removeBinding(patchedConfig, b.binding);
    const idx = openClawBindings.findIndex((ob) =>
      ob.agentId === b.binding.agentId &&
      ob.match.channel === b.binding.match.channel,
    );
    if (idx !== -1) openClawBindings.splice(idx, 1);
  }

  // Add new agents and bindings
  for (const change of plan.agents.filter((a) => a.type === 'add')) {
    const agentDef = manifest.agents[change.slug];
    patchedConfig = addAgentEntry(patchedConfig, {
      id: change.agentId,
      name: change.slug,
      workspace: resolveWorkspacePath(change.agentId),
      model: agentDef.model,
    });
  }
  for (const b of plan.bindings.filter((b) => b.type === 'add')) {
    patchedConfig = addBinding(patchedConfig, b.binding);
    openClawBindings.push(b.binding);
  }

  // Update a2a
  if (plan.a2a.length > 0) {
    const hasNewEdges = plan.a2a.some((e) => e.type === 'add' || e.type === 'reapply');
    if (hasNewEdges) {
      patchedConfig = setAgentToAgent(patchedConfig, namespace);
    }
  }

  const { path: configPath } = await readConfig();
  await writeConfig(configPath, patchedConfig, { silent: true });

  // 9d. Update cron jobs
  if (plan.cron.length > 0) {
    deploySpinner.text = 'Updating cron jobs...';
    try {
      const gwUrl =
        options.gatewayUrl ?? resolveGatewayUrl(patchedConfig, process.env);
      const gwAuth = resolveGatewayAuth({
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        gatewayPassword: options.gatewayPassword,
        config: patchedConfig,
      });
      const gw = new GatewayClient({ url: gwUrl, ...gwAuth });
      await gw.connect();

      for (const change of plan.cron) {
        if (change.type === 'remove' && change.oldCron) {
          try {
            await gw.cronRemove(change.oldCron.id);
          } catch { /* Already gone */ }
          const idx = cronJobStates.findIndex((j) => j.id === change.oldCron!.id);
          if (idx !== -1) cronJobStates.splice(idx, 1);
        } else if (change.type === 'add' && change.newCron) {
          const cronAgentId = idValidation.ids.get(change.agentSlug);
          if (cronAgentId) {
            const result = await gw.cronAdd({
              name: change.name,
              agentId: cronAgentId,
              enabled: true,
              schedule: {
                kind: 'cron',
                expr: change.newCron.schedule,
                tz: change.newCron.timezone,
              },
              sessionTarget: 'isolated',
              wakeMode: 'now',
              payload: {
                kind: 'agentTurn',
                message: change.newCron.prompt,
              },
            });
            cronJobStates.push({
              id: result.id,
              name: change.name,
              agentSlug: change.agentSlug,
              schedule: change.newCron.schedule,
              timezone: change.newCron.timezone,
              prompt: change.newCron.prompt,
            });
          }
        } else if (change.type === 'update' && change.oldCron && change.newCron) {
          const cronAgentId = idValidation.ids.get(change.agentSlug);
          if (cronAgentId) {
            await gw.cronUpdate(change.oldCron.id, {
              schedule: {
                kind: 'cron',
                expr: change.newCron.schedule,
                tz: change.newCron.timezone,
              },
              payload: {
                kind: 'agentTurn',
                message: change.newCron.prompt,
              },
              agentId: cronAgentId,
              enabled: true,
            });
            const existing = cronJobStates.find(
              (j) => j.id === change.oldCron!.id,
            );
            if (existing) {
              existing.schedule = change.newCron.schedule;
              existing.timezone = change.newCron.timezone;
              existing.prompt = change.newCron.prompt;
            }
          }
        }
      }

      gw.close();
    } catch (err) {
      deploySpinner.warn(
        `Gateway error during cron update: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // 10. Save updated state
  const variablesForState: Record<string, string> = {};
  for (const [name, config] of Object.entries(manifest.variables ?? {})) {
    if (config.sensitive) {
      variablesForState[name] = `$${name}`;
    } else {
      variablesForState[name] = resolvedVars[name] ?? '';
    }
  }

  const a2aState = existingState.agentToAgent ?? { wasEnabled: false, allowAdded: false };
  if (manifest.agentToAgent && Object.keys(manifest.agentToAgent).length > 0) {
    a2aState.allowAdded = true;
  }

  const updatedState: FormationState = {
    name: manifest.name,
    version: manifest.version,
    namespace,
    installedAt: existingState.installedAt,
    updatedAt: new Date().toISOString(),
    agents: agentStates,
    bindings: openClawBindings,
    cronJobs: cronJobStates,
    variables: variablesForState,
    fileHashes,
    agentToAgent: a2aState.allowAdded ? a2aState : undefined,
    sourcePath: formationPath,
    agentToAgentEdges: manifest.agentToAgent ?? undefined,
  };

  await saveState(updatedState);

  // 11. Summary
  deploySpinner.succeed('Migration applied');
  console.log('');

  const added = plan.agents.filter((a) => a.type === 'add').length;
  const removed = plan.agents.filter((a) => a.type === 'remove').length;
  const updated = plan.agents.filter((a) => a.type === 'update').length;

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (plan.bindings.length > 0) parts.push(`${plan.bindings.length} binding changes`);
  if (plan.cron.length > 0) parts.push(`${plan.cron.length} cron changes`);

  console.log(
    `${icons.success} ${chalk.green(parts.join(', '))}`,
  );
  console.log('');
  console.log(
    `  ${label('Status:')} reef status ${namespace}/${manifest.name}`,
  );
}
