import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { resolveFormationPath } from '../utils/tarball.js';
import { interpolate, buildToolsList } from '../core/template-interpolator.js';
import {
  resolveWorkspacePath,
  resolveGatewayUrl,
  resolveStateDir,
  resolveAgentStatePaths,
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
  recomputeAgentToAgent,
  updateAgentEntry,
  extractChannelType,
  isBareChannel,
  getConfiguredChannels,
  ensureChannelAllowlisted,
} from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth } from '../core/gateway-client.js';
import {
  loadState,
  saveState,
  listStates,
  computeFileHash,
  persistSourceSnapshot,
} from '../core/state-manager.js';
import { generateAgentsMd } from '../core/agents-md-generator.js';
import { listFiles } from '../utils/fs.js';
import { computeFormationDiff, DiffValidationError } from '../core/diff-engine.js';
import { displayMigrationPlan } from '../utils/plan-display.js';
import { enforceLockfile } from '../core/skills-registry.js';
import { installSkills } from '../core/skills-installer.js';
import { checkOpenClawCompatibility } from '../core/compat-check.js';
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
  allowChannelShadow?: boolean;
  skipCompat?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  registryUrl?: string;
  skipCache?: boolean;
}

const TOKEN_RE = /\{\{\w+\}\}/;

function isBinaryBuffer(buf: Buffer): boolean {
  const check = buf.subarray(0, 8192);
  return check.includes(0);
}

export async function update(
  inputPath: string,
  options: UpdateOptions,
): Promise<void> {
  // Resolve tarball, local path, or registry name to directory
  const { formationPath, tempDir, registryRef } = await resolveFormationPath(
    inputPath,
    { registryUrl: options.registryUrl, skipCache: options.skipCache },
  );
  try {
    await _update(formationPath, options, registryRef);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function _update(
  formationPath: string,
  options: UpdateOptions,
  registryRef?: { name: string; version: string },
): Promise<void> {
  // Use shared diff engine for steps 1-5
  const spinner = ora('Loading formation...').start();

  let diffResult;
  try {
    diffResult = await computeFormationDiff(formationPath, {
      namespace: options.namespace,
      set: options.set,
      noEnv: options.noEnv,
    });
  } catch (err) {
    if (err instanceof DiffValidationError) {
      spinner.fail(err.message);
      process.exit(1);
    }
    spinner.fail('Failed to load formation');
    throw err;
  }

  const { plan, manifest, state: existingState, namespace, idMap, newFileHashes, resolvedVars } = diffResult;

  spinner.succeed('Formation loaded and validated');

  // Compatibility check
  if (manifest.compatibility?.openclaw && !options.skipCompat) {
    const compatSpinner = ora('Checking OpenClaw compatibility...').start();
    const compatResult = await checkOpenClawCompatibility(
      manifest.compatibility.openclaw,
      {
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        gatewayPassword: options.gatewayPassword,
      },
    );

    if (!compatResult.compatible) {
      compatSpinner.fail('Compatibility check failed');
      console.error(`  ${icons.error} ${compatResult.error}`);
      if (compatResult.openclawVersion) {
        console.error(
          `  Running: OpenClaw ${compatResult.openclawVersion} (via ${compatResult.source})`,
        );
        console.error(`  Required: ${compatResult.requiredRange}`);
      }
      console.error('  Use --skip-compat to override.');
      process.exit(1);
    }

    compatSpinner.succeed(
      `OpenClaw ${compatResult.openclawVersion} satisfies ${compatResult.requiredRange}`,
    );
  }

  // Lockfile enforcement
  if (manifest.dependencies?.skills && Object.keys(manifest.dependencies.skills).length > 0) {
    try {
      await enforceLockfile(formationPath, manifest.dependencies.skills, {
        registryUrl: options.registryUrl,
        skipCache: options.skipCache,
      });
    } catch (err) {
      console.error(`${icons.error} ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  if (plan.isEmpty) {
    // Always persist snapshot — even on no-op — to fix dead sourcePath
    const snapshotPath = await persistSourceSnapshot(
      formationPath, namespace, manifest.name,
    );
    const registryRefChanged =
      JSON.stringify(existingState.registryRef) !==
      JSON.stringify(registryRef);
    const sourcePathChanged = existingState.sourcePath !== snapshotPath;
    if (registryRefChanged || sourcePathChanged) {
      const patchedState: FormationState = {
        ...existingState,
        registryRef,
        sourcePath: snapshotPath,
      };
      await saveState(patchedState);
    }
    console.log(
      `${icons.success} ${chalk.green('Already up to date.')}`,
    );
    return;
  }

  // 5b. Classify net-new add bindings by channel availability
  const { config: currentConfig } = await readConfig();

  // Warn if agents.list is non-empty but has no "main" entry
  const agentsListForWarn = (
    (currentConfig.agents as Record<string, unknown>)?.list as Record<string, unknown>[]
  ) ?? [];
  if (
    agentsListForWarn.length > 0 &&
    !agentsListForWarn.some((a) => String(a.id).trim().toLowerCase() === 'main')
  ) {
    console.log(
      `${icons.warning} ${chalk.yellow('agents.list has no "main" entry — your default agent may be missing. Add { id: "main" } to agents.list to restore.')}`,
    );
  }

  const configuredChannels = getConfiguredChannels(currentConfig);

  const addBindingsWithStatus = plan.bindings
    .filter(b => b.type === 'add')
    .map(b => {
      const channelType = extractChannelType(b.binding.match.channel);
      const status = configuredChannels === null ? 'unknown' as const
        : configuredChannels.has(channelType) ? 'configured' as const
        : 'unconfigured' as const;
      return { change: b, channelType, status, isBare: false };
    });
  const removeBindings = plan.bindings.filter(b => b.type === 'remove');

  // 6. Print migration plan using shared display
  displayMigrationPlan(plan, namespace, manifest.name);

  // Check if all net-new adds would be skipped with nothing else to do (--yes mode only)
  const allAddsWouldBeSkipped = addBindingsWithStatus.length > 0 &&
    addBindingsWithStatus.every(b =>
      b.status === 'unconfigured' || (b.isBare && !options.allowChannelShadow),
    );
  const hasOtherChanges = plan.agents.some(a => a.type !== 'unchanged') ||
    plan.cron.length > 0 ||
    plan.a2a.length > 0 ||
    plan.versionChange !== null ||
    removeBindings.length > 0;

  if (options.yes && allAddsWouldBeSkipped && !hasOtherChanges) {
    console.log('');
    console.log(
      `No applicable changes (${addBindingsWithStatus.length} new binding${addBindingsWithStatus.length !== 1 ? 's' : ''} skipped).`,
    );
    return;
  }

  // 7. Dry run
  if (options.dryRun) {
    console.log('');
    console.log(label('Dry run — no changes applied.'));
    return;
  }

  // Install skills via gateway if available
  if (manifest.dependencies?.skills && Object.keys(manifest.dependencies.skills).length > 0) {
    const skillResults = await installSkills(manifest.dependencies.skills, {
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      gatewayPassword: options.gatewayPassword,
    });

    for (const result of skillResults) {
      if (result.status === 'installed') {
        console.log(`  ${icons.success} Skill "${result.name}" installed`);
      } else if (result.status === 'already_installed') {
        // Silent — no output needed for already installed skills
      } else if (result.status === 'skipped') {
        console.log(`  ${icons.warning} Skill "${result.name}" skipped (gateway unavailable)`);
      } else if (result.status === 'failed') {
        console.warn(`  ${icons.warning} Skill "${result.name}" installation failed: ${result.error}`);
      }
    }
  }

  // 8. Channel-aware filtering for net-new bindings + confirm
  let finalAddBindings = addBindingsWithStatus.map(b => b.change);

  if (options.yes) {
    // Auto-skip unconfigured and bare adds
    finalAddBindings = addBindingsWithStatus
      .filter(b => b.status !== 'unconfigured' && (!b.isBare || options.allowChannelShadow))
      .map(b => b.change);

    // Log per-channel-type warnings for unconfigured
    const skippedTypes = [...new Set(
      addBindingsWithStatus
        .filter(b => b.status === 'unconfigured')
        .map(b => b.channelType),
    )].sort();
    for (const ct of skippedTypes) {
      console.log(
        `${icons.warning} ${chalk.yellow(`Skipping bindings for unconfigured channel: ${ct}`)}`,
      );
    }
    // Log per-channel-type warnings for bare
    if (!options.allowChannelShadow) {
      const bareSkippedTypes = [...new Set(
        addBindingsWithStatus
          .filter(b => b.isBare && b.status !== 'unconfigured')
          .map(b => b.channelType),
      )].sort();
      for (const ct of bareSkippedTypes) {
        console.log(
          `${icons.warning} ${chalk.yellow(`Skipping bare binding for ${ct} (shadows main agent)`)}`,
        );
      }
    }
  } else {
    // Interactive path: checkbox for add bindings if unconfigured or bare exist
    const hasUnconfigured = addBindingsWithStatus.some(
      b => b.status === 'unconfigured',
    );
    const hasBare = addBindingsWithStatus.some(
      b => b.isBare && b.status !== 'unconfigured',
    );
    if (hasUnconfigured || hasBare) {
      const { checkbox } = await import('@inquirer/prompts');
      const choices = addBindingsWithStatus.map(b => ({
        name: `${b.change.binding.match.channel} → ${b.change.binding.agentId} [${b.status}${b.isBare && b.status !== 'unconfigured' ? ', bare' : ''}]`,
        value: b,
        checked: b.status !== 'unconfigured' && !b.isBare,
      }));
      const selected = await checkbox({
        message: 'Select new bindings to add (unconfigured/bare channels are unchecked):',
        choices,
      });
      finalAddBindings = selected.map(b => b.change);

      // Post-selection no-op guard
      if (finalAddBindings.length === 0 && !hasOtherChanges) {
        console.log(
          `No applicable changes (${addBindingsWithStatus.length} new binding${addBindingsWithStatus.length !== 1 ? 's' : ''} skipped).`,
        );
        return;
      }
    }

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

  const skippedCount = addBindingsWithStatus.length - finalAddBindings.length;

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
        const agentVars = {
          ...resolvedVars,
          tools: buildToolsList(agentDef.tools?.allow, manifest.dependencies?.skills),
        };
        content = interpolate(content, agentVars);
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
      tools: agentDef.tools as Record<string, unknown> | undefined,
    });
  }
  // Update existing agents (reconcile model/tools changes)
  for (const change of plan.agents.filter((a) => a.type === 'update')) {
    const agentDef = manifest.agents[change.slug];
    patchedConfig = updateAgentEntry(patchedConfig, change.agentId, {
      model: agentDef.model,
      tools: agentDef.tools as Record<string, unknown> | undefined,
    });
  }
  for (const b of finalAddBindings) {
    patchedConfig = addBinding(patchedConfig, b.binding);
    patchedConfig = ensureChannelAllowlisted(patchedConfig, b.binding);
    openClawBindings.push(b.binding);
  }

  // Update a2a — recompute from full topology on any change
  if (plan.a2a.length > 0) {
    patchedConfig = recomputeAgentToAgent(
      patchedConfig,
      namespace,
      manifest.agentToAgent,
    );
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
          const cronAgentId = idMap.get(change.agentSlug);
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
          const cronAgentId = idMap.get(change.agentSlug);
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
  const hasTopology = manifest.agentToAgent &&
    Object.values(manifest.agentToAgent).some((targets) => targets.length > 0);
  if (hasTopology) {
    a2aState.allowAdded = true;
  } else if (plan.a2a.some((e) => e.type === 'remove')) {
    // Topology was emptied — mark as no longer added
    a2aState.allowAdded = false;
  }

  // Persist source snapshot so sourcePath survives temp dir cleanup
  const snapshotPath = await persistSourceSnapshot(formationPath, namespace, manifest.name);

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
    sourcePath: snapshotPath,
    agentToAgentEdges: manifest.agentToAgent ?? undefined,
    registryRef,
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
  const bindingChangeCount = finalAddBindings.length + removeBindings.length;
  if (bindingChangeCount > 0 || skippedCount > 0) {
    // Compute skip-reason breakdown
    let skippedSuffix = '';
    const skipParts: string[] = [];
    if (skippedCount > 0) {
      const finalAddSet = new Set(finalAddBindings);
      const unconfiguredSkipped = addBindingsWithStatus.filter(
        b => b.status === 'unconfigured' && !finalAddSet.has(b.change),
      ).length;
      const bareSkipped = addBindingsWithStatus.filter(
        b => b.isBare && b.status !== 'unconfigured' && !finalAddSet.has(b.change),
      ).length;
      const userDeselected = skippedCount - unconfiguredSkipped - bareSkipped;

      if (unconfiguredSkipped > 0) skipParts.push(`${unconfiguredSkipped} unconfigured`);
      if (bareSkipped > 0) skipParts.push(`${bareSkipped} bare channel shadows`);
      if (userDeselected > 0) skipParts.push(`${userDeselected} user-deselected`);
      skippedSuffix = `, ${skippedCount} skipped (${skipParts.join(', ')})`;
    }
    if (bindingChangeCount > 0) {
      parts.push(`${bindingChangeCount} binding changes${skippedSuffix}`);
    } else if (skippedCount > 0) {
      parts.push(`${skippedCount} bindings skipped (${skipParts.join(', ')})`);
    }
  }
  if (plan.cron.length > 0) parts.push(`${plan.cron.length} cron changes`);

  console.log(
    `${icons.success} ${chalk.green(parts.join(', '))}`,
  );
  console.log('');
  console.log(
    `  ${label('Status:')} reef status ${namespace}/${manifest.name}`,
  );
}
