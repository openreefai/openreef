import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { resolveFormationPath } from '../utils/tarball.js';
import { loadManifest } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { validateStructure } from '../core/structural-validator.js';
import { resolveVariables } from '../core/variable-resolver.js';
import { interpolate, buildToolsList } from '../core/template-interpolator.js';
import {
  resolveWorkspacePath,
  resolveGatewayUrl,
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
  getConfiguredChannels,
  classifyBindings,
  resolveSelectedBindings,
  isBareChannel,
  pruneMatchObject,
  expandCompoundChannel,
  ensureChannelAllowlisted,
} from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth } from '../core/gateway-client.js';
import {
  loadState,
  saveState,
  deleteState,
  listStates,
  computeFileHash,
  persistSourceSnapshot,
} from '../core/state-manager.js';
import { generateAgentsMd } from '../core/agents-md-generator.js';
import { listFiles } from '../utils/fs.js';
import { enforceLockfile } from '../core/skills-registry.js';
import { installSkills } from '../core/skills-installer.js';
import { checkOpenClawCompatibility } from '../core/compat-check.js';
import { icons, header, label, value, table } from '../utils/output.js';
import type { ReefManifest, Binding, BindingMatch } from '../types/manifest.js';
import type {
  FormationState,
  AgentState,
  CronJobState,
  OpenClawBinding,
} from '../types/state.js';

export interface InstallOptions {
  set?: string[];
  namespace?: string;
  force?: boolean;
  merge?: boolean;
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

export async function install(
  inputPath: string,
  options: InstallOptions,
): Promise<void> {
  // Resolve tarball, local path, or registry name to directory
  const { formationPath, tempDir, registryRef } = await resolveFormationPath(
    inputPath,
    { registryUrl: options.registryUrl, skipCache: options.skipCache },
  );
  try {
    await _install(formationPath, options, registryRef);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function _install(
  formationPath: string,
  options: InstallOptions,
  registryRef?: { name: string; version: string },
): Promise<void> {
  // ── Phase 1: Parse + Validate IDs ──
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

  // ── Phase 1b: Compatibility check ──
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
        console.error(
          `  Required: ${compatResult.requiredRange}`,
        );
      }
      console.error('  Use --skip-compat to override.');
      process.exit(1);
    }

    compatSpinner.succeed(
      `OpenClaw ${compatResult.openclawVersion} satisfies ${compatResult.requiredRange}`,
    );
  }

  // ── Phase 2: Variables ──
  const { resolved: resolvedVars, missing } = await resolveVariables(
    manifest.variables ?? {},
    formationPath,
    {
      interactive: !options.yes,
      cliOverrides: parseSets(options.set),
      noEnv: options.noEnv,
      allowExternalCommands: !options.yes,
    },
  );

  if (missing.length > 0) {
    console.error(
      `${icons.error} Missing required variables: ${missing.join(', ')}`,
    );
    console.error(
      '  Use --set KEY=VALUE or set them in .env / environment.',
    );
    process.exit(1);
  }

  // Inject built-in variable: namespace
  resolvedVars.namespace = namespace;

  // Resolve {{VARIABLE}} tokens in binding match fields;
  // drop bindings that still contain unresolved {{...}} tokens (unset optional vars)
  const TOKEN_RE_CHECK = /\{\{\w+\}\}/;

  function interpolateMatch(match: Binding['match']): Binding['match'] {
    const result: Binding['match'] = {
      channel: interpolate(match.channel, resolvedVars),
    };
    if (match.accountId) result.accountId = interpolate(match.accountId, resolvedVars);
    if (match.peer) {
      result.peer = {
        kind: interpolate(match.peer.kind, resolvedVars) as 'direct' | 'group' | 'channel',
        id: interpolate(match.peer.id, resolvedVars),
      };
    }
    if (match.guildId) result.guildId = interpolate(match.guildId, resolvedVars);
    if (match.teamId) result.teamId = interpolate(match.teamId, resolvedVars);
    if (match.roles) result.roles = match.roles;
    return result;
  }

  function matchHasUnresolved(match: Binding['match']): string | null {
    if (TOKEN_RE_CHECK.test(match.channel)) return match.channel;
    if (match.accountId && TOKEN_RE_CHECK.test(match.accountId)) return match.accountId;
    if (match.peer?.kind && TOKEN_RE_CHECK.test(match.peer.kind)) return match.peer.kind;
    if (match.peer?.id && TOKEN_RE_CHECK.test(match.peer.id)) return match.peer.id;
    if (match.guildId && TOKEN_RE_CHECK.test(match.guildId)) return match.guildId;
    if (match.teamId && TOKEN_RE_CHECK.test(match.teamId)) return match.teamId;
    return null;
  }

  const resolvedBindings: Binding[] = (manifest.bindings ?? [])
    .map((b) => ({ ...b, match: interpolateMatch(b.match) }))
    .map((b) => {
      // Prune empty optional fields from the match object
      const pruned = pruneMatchObject(b.match as unknown as Record<string, unknown>);
      return { ...b, match: pruned as unknown as Binding['match'] };
    })
    .map((b) => {
      // Expand compound "type:scope" channel values into channel + peer
      const expanded = expandCompoundChannel(b.match as unknown as Record<string, unknown>);
      return { ...b, match: expanded as unknown as Binding['match'] };
    })
    .filter((b) => {
      if (b.match.channel.trim() === '') return false;
      const unresolved = matchHasUnresolved(b.match);
      if (unresolved) {
        console.log(
          `${icons.warning} ${chalk.yellow(`Skipping binding "${unresolved}" → ${b.agent}: unresolved variable`)}`,
        );
        return false;
      }
      return true;
    });

  // ── Phase 3: Conflicts ──
  const { config, path: configPath } = await readConfig();
  const existingState = await loadState(namespace, manifest.name);

  // Warn if agents.list is non-empty but has no "main" entry
  const agentsListForWarn = (
    (config.agents as Record<string, unknown>)?.list as Record<string, unknown>[]
  ) ?? [];
  if (
    agentsListForWarn.length > 0 &&
    !agentsListForWarn.some((a) => String(a.id).trim().toLowerCase() === 'main')
  ) {
    console.log(
      `${icons.warning} ${chalk.yellow('agents.list has no "main" entry — your default agent may be missing. Add { id: "main" } to agents.list to restore.')}`,
    );
  }

  // Channel availability for binding selection
  const configuredChannels = getConfiguredChannels(config);
  const classifiedBindingsList = classifyBindings(resolvedBindings, configuredChannels);

  // DRY-RUN: report conflicts and planned changes, then exit cleanly
  if (options.dryRun) {
    console.log('');
    console.log(header('Dry Run — No changes will be made'));
    console.log('');

    // Report conflicts informationally
    if (existingState && !options.force && !options.merge) {
      console.log(
        `${icons.warning} Conflict: Formation "${namespace}/${manifest.name}" is already installed.`,
      );
      console.log('  With --force: would remove existing installation first.');
      console.log('  With --merge: would update in-place.');
      console.log('');
    }

    // Show what --force would do
    if (options.force && existingState) {
      console.log('Would first remove existing installation:');
      for (const agent of Object.values(existingState.agents)) {
        console.log(`  - Agent ${agent.id} from config`);
        console.log(`  - Workspace ${agent.workspace}`);
      }
      for (const binding of existingState.bindings) {
        console.log(`  - Binding ${binding.match.channel} → ${binding.agentId}`);
      }
      for (const job of existingState.cronJobs) {
        console.log(`  - Cron job ${job.name} (${job.id})`);
      }
      console.log(`  - State file ${existingState.namespace}/${existingState.name}`);
      console.log('');
      console.log('Then deploy fresh:');
    } else {
      console.log('Would deploy:');
    }

    // Show deploy plan
    console.log(
      `  ${label('Formation:')} ${value(`${namespace}/${manifest.name}`)} v${manifest.version}`,
    );
    for (const [slug, agentDef] of Object.entries(manifest.agents)) {
      const agentId = idValidation.ids.get(slug)!;
      console.log(
        `  + Agent ${slug} → ${agentId}${agentDef.model ? ` (model: ${agentDef.model})` : ''}`,
      );
    }
    for (const cb of classifiedBindingsList) {
      const resolvedAgentId = idValidation.ids.get(cb.binding.agent);
      if (resolvedAgentId) {
        const isFreshOrForce = !options.merge;
        let skipAnnotation = '';
        if (isFreshOrForce) {
          if (cb.status === 'unconfigured') {
            skipAnnotation = ' (channel not configured — would be skipped)';
          } else if (cb.isBare) {
            skipAnnotation = ' (bare channel — shadows main, would be skipped)';
          }
        }
        console.log(`  + Binding ${cb.binding.match.channel} → ${resolvedAgentId}${skipAnnotation}`);
      }
    }
    for (const cronEntry of manifest.cron ?? []) {
      console.log(
        `  + Cron ${cronEntry.schedule} → ${namespace}-${cronEntry.agent}`,
      );
    }
    console.log(`  + State file ${namespace}/${manifest.name} v${manifest.version}`);
    return;
  }

  if (existingState && !options.force && !options.merge) {
    console.error(
      `${icons.error} Formation "${namespace}/${manifest.name}" is already installed.`,
    );
    console.error('  Use --force to replace or --merge to update.');
    process.exit(1);
  }

  // Check for agent ID conflicts in config (from other formations)
  if (!options.force && !options.merge) {
    const agentsList = (
      (config.agents as Record<string, unknown>)?.list as Record<
        string,
        unknown
      >[]
    ) ?? [];
    const conflicting = agentsList.filter((a) => {
      const id = a.id as string;
      return id.startsWith(`${namespace}-`) && idValidation.ids.has(
        slugs.find((s) => `${namespace}-${s}` === id) ?? '',
      );
    });
    if (conflicting.length > 0) {
      console.error(
        `${icons.error} Config already contains agents with matching IDs:`,
      );
      for (const a of conflicting) {
        console.error(`  - ${a.id}`);
      }
      console.error('  Use --force to replace.');
      process.exit(1);
    }
  }

  // --force cleanup
  if (options.force && existingState) {
    if (!options.yes) {
      const { confirm } = await import('@inquirer/prompts');
      const ok = await confirm({
        message: `This will remove the existing installation of "${namespace}/${manifest.name}". Continue?`,
      });
      if (!ok) {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    const cleanupSpinner = ora('Cleaning up existing installation...').start();

    // Remove cron jobs via RPC
    if (existingState.cronJobs.length > 0) {
      try {
        const gwUrl =
          options.gatewayUrl ?? resolveGatewayUrl(config, process.env);
        const gwAuth = resolveGatewayAuth({
          gatewayUrl: options.gatewayUrl,
          gatewayToken: options.gatewayToken,
          gatewayPassword: options.gatewayPassword,
          config,
        });
        const gw = new GatewayClient({
          url: gwUrl,
          ...gwAuth,
        });
        await gw.connect();
        for (const job of existingState.cronJobs) {
          try {
            await gw.cronRemove(job.id);
          } catch {
            // Job may already be gone
          }
        }
        gw.close();
      } catch {
        cleanupSpinner.warn(
          'Could not connect to Gateway for cron cleanup — jobs may be orphaned',
        );
      }
    }

    // Remove from config
    let cleanConfig = config;
    for (const agent of Object.values(existingState.agents)) {
      cleanConfig = removeAgentEntry(cleanConfig, agent.id);
    }
    for (const binding of existingState.bindings) {
      cleanConfig = removeBinding(cleanConfig, binding);
    }
    // Remove agentToAgent allow entry
    if (existingState.agentToAgent?.allowAdded) {
      const allStates = await listStates();
      const otherInNamespace = allStates.some(
        (s) =>
          s.namespace === namespace &&
          s.name !== existingState!.name,
      );
      cleanConfig = removeAgentToAgent(
        cleanConfig,
        namespace,
        otherInNamespace,
        existingState.agentToAgent.wasEnabled,
      );
    }
    await writeConfig(configPath, cleanConfig, { silent: true });

    // Delete workspaces
    const { rm } = await import('node:fs/promises');
    for (const agent of Object.values(existingState.agents)) {
      try {
        await rm(agent.workspace, { recursive: true, force: true });
      } catch {
        // Already gone
      }
    }

    await deleteState(namespace, manifest.name);
    cleanupSpinner.succeed('Cleaned up existing installation');
  }

  // ── Phase 4: Dependencies ──
  // Lockfile enforcement for skills
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

  // Install skills via gateway if available
  if (manifest.dependencies?.skills && Object.keys(manifest.dependencies.skills).length > 0) {
    const skillResults = await installSkills(manifest.dependencies.skills, {
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      gatewayPassword: options.gatewayPassword,
      config,
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

  // Per-service dependency warnings
  if (manifest.dependencies?.services?.length) {
    const required = manifest.dependencies.services.filter((s) => s.required);
    const optional = manifest.dependencies.services.filter((s) => !s.required);

    if (required.length > 0) {
      console.log(`  ${chalk.red(icons.warning)} ${chalk.bold('Required services:')}`);
      for (const svc of required) {
        const urlPart = svc.url ? chalk.dim(` (${svc.url})`) : '';
        const descPart = svc.description ? chalk.dim(` - ${svc.description}`) : '';
        console.log(`    - ${chalk.bold(svc.name)}${urlPart}${descPart}`);
      }
    }
    if (optional.length > 0) {
      console.log(`  ${chalk.dim(icons.info)} ${chalk.dim('Optional services:')}`);
      for (const svc of optional) {
        const descPart = svc.description ? chalk.dim(` - ${svc.description} (not required)`) : chalk.dim(' (not required)');
        console.log(`    - ${svc.name}${descPart}`);
      }
    }
    if (required.length > 0) {
      console.log('  Ensure required services are configured before proceeding.');
    }
  }

  // ── Phase 5: Confirm ──
  let interactiveSelectedBindings: Binding[] | undefined;
  if (!options.yes && !options.merge) {
    console.log('');
    console.log(header('Deployment Plan'));
    console.log('');
    console.log(
      `${label('Formation:')} ${value(`${namespace}/${manifest.name}`)} v${manifest.version}`,
    );
    console.log('');

    // Agents
    console.log(label('Agents:'));
    const agentRows: string[][] = [];
    for (const [slug] of Object.entries(manifest.agents)) {
      agentRows.push([
        `  ${slug}`,
        `→ ${idValidation.ids.get(slug)}`,
      ]);
    }
    console.log(table(agentRows));

    // Bindings
    if (classifiedBindingsList.length > 0) {
      console.log('');
      console.log(label('Channel Bindings:'));
      for (const cb of classifiedBindingsList) {
        const statusTag =
          cb.status === 'configured'
            ? chalk.green(' (configured)')
            : cb.status === 'unconfigured'
              ? chalk.yellow(' (not configured)')
              : '';
        console.log(
          `  ${cb.binding.match.channel} → ${namespace}-${cb.binding.agent}${statusTag}`,
        );
      }
    }

    // Cron
    if (manifest.cron?.length) {
      console.log('');
      console.log(label('Cron Jobs:'));
      for (const c of manifest.cron) {
        console.log(
          `  ${c.schedule} → ${namespace}-${c.agent}: "${c.prompt.slice(0, 60)}${c.prompt.length > 60 ? '...' : ''}"`,
        );
      }
    }

    // Variables
    if (manifest.variables && Object.keys(manifest.variables).length > 0) {
      console.log('');
      console.log(label('Variables:'));
      for (const [name, config] of Object.entries(manifest.variables)) {
        const val = config.sensitive
          ? '********'
          : (resolvedVars[name] ?? '(not set)');
        console.log(`  ${name} = ${val}`);
      }
    }

    console.log('');
    const { confirm, checkbox } = await import('@inquirer/prompts');

    // Interactive binding selection for fresh/force installs with unconfigured or bare bindings
    const hasUnconfigured = classifiedBindingsList.some(
      (cb) => cb.status === 'unconfigured',
    );
    const hasBare = classifiedBindingsList.some(
      (cb) => cb.isBare && cb.status !== 'unconfigured',
    );
    if ((hasUnconfigured || hasBare) && !options.merge) {
      const choices = classifiedBindingsList.map((cb) => ({
        name: `${cb.binding.match.channel} → ${namespace}-${cb.binding.agent} [${cb.status}${cb.isBare && cb.status !== 'unconfigured' ? ', bare' : ''}]`,
        value: cb.binding,
        checked: cb.status !== 'unconfigured' && !cb.isBare,
      }));
      interactiveSelectedBindings = await checkbox({
        message: 'Select bindings to wire (unconfigured/bare channels are unchecked):',
        choices,
      });

      // Post-selection no-op guard: if user unchecked everything and no other content
      if (interactiveSelectedBindings.length === 0) {
        const hasOtherContent = Object.keys(manifest.agents).length > 0 ||
          (manifest.cron?.length ?? 0) > 0;
        if (!hasOtherContent) {
          console.log('No bindings selected and no other content to deploy.');
          process.exit(0);
        }
      }
    }

    const proceed = await confirm({ message: 'Deploy this formation?' });
    if (!proceed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Compute selectedBindings based on mode and user choices
  let selectedBindings: Binding[];
  if (options.merge) {
    // --merge wires all resolved bindings, no channel filtering
    selectedBindings = resolvedBindings;
  } else if (!options.yes) {
    // Interactive path: use checkbox result if it was shown, otherwise default
    selectedBindings =
      typeof interactiveSelectedBindings !== 'undefined'
        ? interactiveSelectedBindings
        : resolveSelectedBindings(classifiedBindingsList);
  } else {
    // --yes non-interactive path
    if (configuredChannels !== null) {
      const skippedTypes = [
        ...new Set(
          classifiedBindingsList
            .filter((cb) => cb.status === 'unconfigured')
            .map((cb) => cb.channelType),
        ),
      ].sort();
      if (skippedTypes.length > 0) {
        for (const ct of skippedTypes) {
          console.log(
            `${icons.warning} ${chalk.yellow(`Skipping bindings for unconfigured channel: ${ct}`)}`,
          );
        }
      }
    }
    // Log bare-channel skip warnings
    if (!options.allowChannelShadow) {
      const bareSkippedTypes = [
        ...new Set(
          classifiedBindingsList
            .filter((cb) => cb.isBare && cb.status !== 'unconfigured')
            .map((cb) => cb.channelType),
        ),
      ].sort();
      for (const ct of bareSkippedTypes) {
        console.log(
          `${icons.warning} ${chalk.yellow(`Skipping bare binding for ${ct} (shadows main agent)`)}`,
        );
      }
    }
    selectedBindings = resolveSelectedBindings(classifiedBindingsList, {
      allowChannelShadow: options.allowChannelShadow,
    });
  }

  // ── Phase 6: Deploy ──
  const deploySpinner = ora('Deploying formation...').start();

  const agentStates: Record<string, AgentState> = {};
  const fileHashes: Record<string, string> = {};
  const cronJobStates: CronJobState[] = [];
  const openClawBindings: OpenClawBinding[] = [];

  // Deploy workspace files
  deploySpinner.text = 'Writing workspace files...';
  for (const [slug, agentDef] of Object.entries(manifest.agents)) {
    const agentId = idValidation.ids.get(slug)!;
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
        // --merge: skip unchanged files
        if (options.merge && existingState) {
          const hash = computeFileHash(rawBytes);
          const existingHash =
            existingState.fileHashes[`${agentId}:${relativePath}`];
          if (existingHash === hash) {
            deployedFiles.push(relativePath);
            fileHashes[`${agentId}:${relativePath}`] = hash;
            continue;
          }
        }
        await writeFile(destPath, rawBytes);
        fileHashes[`${agentId}:${relativePath}`] = computeFileHash(rawBytes);
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

      // --merge: skip unchanged files
      if (options.merge && existingState) {
        const hash = computeFileHash(written);
        const existingHash =
          existingState.fileHashes[`${agentId}:${relativePath}`];
        if (existingHash === hash) {
          deployedFiles.push(relativePath);
          fileHashes[`${agentId}:${relativePath}`] = hash;
          continue;
        }
      }

      await writeFile(destPath, written);
      fileHashes[`${agentId}:${relativePath}`] = computeFileHash(written);
      deployedFiles.push(relativePath);
    }

    // Generate AGENTS.md
    if (manifest.agentToAgent?.[slug]?.length) {
      const agentsMd = generateAgentsMd(manifest, slug, namespace);
      const buf = Buffer.from(agentsMd, 'utf-8');
      await writeFile(join(workspacePath, 'AGENTS.md'), buf);
      fileHashes[`${agentId}:AGENTS.md`] = computeFileHash(buf);
      deployedFiles.push('AGENTS.md');
    }

    agentStates[slug] = {
      id: agentId,
      slug,
      workspace: workspacePath,
      files: deployedFiles,
      model: agentDef.model,
    };
  }

  // Patch config
  deploySpinner.text = 'Patching OpenClaw config...';
  let patchedConfig = (await readConfig(configPath)).config;

  for (const [slug, agentDef] of Object.entries(manifest.agents)) {
    const agentId = idValidation.ids.get(slug)!;
    patchedConfig = addAgentEntry(patchedConfig, {
      id: agentId,
      name: slug,
      workspace: resolveWorkspacePath(agentId),
      model: agentDef.model,
      tools: agentDef.tools as Record<string, unknown> | undefined,
      // Note: manifest sandbox (network/filesystem) is declarative intent and
      // does not map 1:1 to OpenClaw's sandbox config schema (mode/workspaceAccess/scope).
      // Omit until a proper translation layer exists.
    });
  }

  // Map bindings — use validated IDs from the map, not raw string composition
  for (const binding of selectedBindings) {
    const resolvedAgentId = idValidation.ids.get(binding.agent);
    if (!resolvedAgentId) {
      console.log(
        `\n${icons.warning} ${chalk.yellow(`Binding references unknown agent "${binding.agent}" — skipped`)}`,
      );
      continue;
    }
    const openClawBinding: OpenClawBinding = {
      agentId: resolvedAgentId,
      match: binding.match,
    };
    patchedConfig = addBinding(patchedConfig, openClawBinding);
    patchedConfig = ensureChannelAllowlisted(patchedConfig, openClawBinding);
    openClawBindings.push(openClawBinding);
  }

  // Agent-to-agent messaging
  const a2aState = { wasEnabled: false, allowAdded: false };
  if (
    manifest.agentToAgent &&
    Object.keys(manifest.agentToAgent).length > 0
  ) {
    const tools = patchedConfig.tools as Record<string, unknown> | undefined;
    const a2a = tools?.agentToAgent as Record<string, unknown> | undefined;
    a2aState.wasEnabled = a2a?.enabled === true;
    patchedConfig = setAgentToAgent(patchedConfig, namespace);
    a2aState.allowAdded = true;
  }

  await writeConfig(configPath, patchedConfig, { silent: options.merge });

  // Cron jobs via Gateway RPC
  if (manifest.cron?.length) {
    deploySpinner.text = 'Creating cron jobs...';
    const gwUrl =
      options.gatewayUrl ?? resolveGatewayUrl(patchedConfig, process.env);
    const gwAuth = resolveGatewayAuth({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      gatewayPassword: options.gatewayPassword,
      config: patchedConfig,
    });
    const gw = new GatewayClient({
      url: gwUrl,
      ...gwAuth,
    });

    try {
      await gw.connect();

      if (options.merge && existingState) {
        // --merge: update existing cron jobs, add new ones
        const existingJobs = await gw.cronList({ includeDisabled: true });
        const existingByName = new Map(
          existingJobs.map((j) => [j.name, j]),
        );

        for (const [i, cronEntry] of manifest.cron.entries()) {
          const jobName = `reef:${namespace}:${cronEntry.agent}-${i}`;
          const existing = existingByName.get(jobName);

          if (existing) {
            // Update in-place
            await gw.cronUpdate(existing.id, {
              schedule: {
                kind: 'cron',
                expr: cronEntry.schedule,
                tz: cronEntry.timezone,
              },
              payload: {
                kind: 'agentTurn',
                message: cronEntry.prompt,
              },
              agentId: idValidation.ids.get(cronEntry.agent)!,
              enabled: true,
            });
            cronJobStates.push({
              id: existing.id,
              name: jobName,
              agentSlug: cronEntry.agent,
              schedule: cronEntry.schedule,
              timezone: cronEntry.timezone,
              prompt: cronEntry.prompt,
            });
          } else {
            // Add new
            const result = await gw.cronAdd({
              name: jobName,
              agentId: idValidation.ids.get(cronEntry.agent)!,
              enabled: true,
              schedule: {
                kind: 'cron',
                expr: cronEntry.schedule,
                tz: cronEntry.timezone,
              },
              sessionTarget: 'isolated',
              wakeMode: 'now',
              payload: {
                kind: 'agentTurn',
                message: cronEntry.prompt,
              },
            });
            cronJobStates.push({
              id: result.id,
              name: jobName,
              agentSlug: cronEntry.agent,
              schedule: cronEntry.schedule,
              timezone: cronEntry.timezone,
              prompt: cronEntry.prompt,
            });
          }
        }
      } else {
        // Fresh install
        for (const [i, cronEntry] of manifest.cron.entries()) {
          const jobName = `reef:${namespace}:${cronEntry.agent}-${i}`;
          const cronAgentId = idValidation.ids.get(cronEntry.agent);
          if (!cronAgentId) {
            console.log(
              `\n${icons.warning} ${chalk.yellow(`Cron job references unknown agent "${cronEntry.agent}" — skipped`)}`,
            );
            continue;
          }
          const result = await gw.cronAdd({
            name: jobName,
            agentId: cronAgentId,
            enabled: true,
            schedule: {
              kind: 'cron',
              expr: cronEntry.schedule,
              tz: cronEntry.timezone,
            },
            sessionTarget: 'isolated',
            wakeMode: 'now',
            payload: {
              kind: 'agentTurn',
              message: cronEntry.prompt,
            },
          });
          cronJobStates.push({
            id: result.id,
            name: jobName,
            agentSlug: cronEntry.agent,
            schedule: cronEntry.schedule,
            timezone: cronEntry.timezone,
            prompt: cronEntry.prompt,
          });
        }
      }
    } catch (err) {
      deploySpinner.fail('Failed to create cron jobs');
      console.error(
        `${icons.error} Gateway error: ${err instanceof Error ? err.message : err}`,
      );
      console.error(
        '  Ensure OpenClaw Gateway is running. Config and workspace files were deployed successfully.',
      );
      // Still save state for what we deployed
    } finally {
      gw.close();
    }
  }

  // ── Phase 7: Validate ──
  deploySpinner.text = 'Validating deployment...';
  const finalConfig = (await readConfig(configPath)).config;
  const agentsList = (
    (finalConfig.agents as Record<string, unknown>)?.list as Record<
      string,
      unknown
    >[]
  ) ?? [];

  // agent_exists: check agents in config
  for (const [slug] of Object.entries(manifest.agents)) {
    const agentId = idValidation.ids.get(slug)!;
    const found = agentsList.some((a) => a.id === agentId);
    if (!found) {
      console.log(
        `\n${icons.warning} Agent "${agentId}" not found in config after deploy`,
      );
    }
  }

  // binding_active: check bindings in config
  const finalBindings = (finalConfig.bindings ?? []) as Record<string, unknown>[];
  for (const binding of openClawBindings) {
    const found = finalBindings.some((b) => {
      const match = b.match as Record<string, unknown> | undefined;
      return b.agentId === binding.agentId && match?.channel === binding.match.channel;
    });
    if (!found) {
      console.log(
        `\n${icons.warning} Binding ${binding.match.channel} → ${binding.agentId} not found in config after deploy`,
      );
    }
  }

  // cron_exists: verify cron jobs via Gateway (if we created any and Gateway is reachable)
  if (cronJobStates.length > 0) {
    try {
      const gwUrl =
        options.gatewayUrl ?? resolveGatewayUrl(patchedConfig, process.env);
      const gwAuth = resolveGatewayAuth({
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        gatewayPassword: options.gatewayPassword,
        config: patchedConfig,
      });
      const verifyGw = new GatewayClient({
        url: gwUrl,
        ...gwAuth,
      });
      await verifyGw.connect();
      const liveJobs = await verifyGw.cronList({ includeDisabled: true });
      verifyGw.close();
      const liveIds = new Set(liveJobs.map((j) => j.id));
      for (const job of cronJobStates) {
        if (!liveIds.has(job.id)) {
          console.log(
            `\n${icons.warning} Cron job "${job.name}" (${job.id}) not found on Gateway after deploy`,
          );
        }
      }
    } catch {
      // Gateway not reachable for verification — skip
    }
  }

  // ── Phase 8: State ──
  const variablesForState: Record<string, string> = {};
  for (const [name, config] of Object.entries(manifest.variables ?? {})) {
    if (config.sensitive) {
      // Store as env var reference, not the secret value
      variablesForState[name] = `$${name}`;
    } else {
      variablesForState[name] = resolvedVars[name] ?? '';
    }
  }

  // Persist source snapshot so sourcePath survives temp dir cleanup
  const snapshotPath = await persistSourceSnapshot(formationPath, namespace, manifest.name);

  const state: FormationState = {
    name: manifest.name,
    version: manifest.version,
    namespace,
    installedAt: new Date().toISOString(),
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

  await saveState(state);

  deploySpinner.succeed('Formation deployed');
  console.log('');
  const totalManifestBindings = resolvedBindings.length;
  const totalSkipped = !options.merge
    ? totalManifestBindings - selectedBindings.length
    : 0;

  // Compute skip-reason breakdown
  let skippedSuffix = '';
  if (totalSkipped > 0 && !options.merge) {
    const unconfiguredSkipped = classifiedBindingsList.filter(
      (cb) => cb.status === 'unconfigured' &&
        !selectedBindings.includes(cb.binding),
    ).length;
    const bareSkipped = classifiedBindingsList.filter(
      (cb) => cb.isBare && cb.status !== 'unconfigured' &&
        !selectedBindings.includes(cb.binding),
    ).length;
    const userDeselected = totalSkipped - unconfiguredSkipped - bareSkipped;

    const parts: string[] = [];
    if (unconfiguredSkipped > 0) parts.push(`${unconfiguredSkipped} unconfigured`);
    if (bareSkipped > 0) parts.push(`${bareSkipped} bare channel shadows`);
    if (userDeselected > 0) parts.push(`${userDeselected} user-deselected`);
    skippedSuffix = `, ${totalSkipped} skipped (${parts.join(', ')})`;
  }
  console.log(
    `${icons.success} ${chalk.green(`${Object.keys(agentStates).length} agents deployed, ${openClawBindings.length} bindings wired, ${cronJobStates.length} cron jobs scheduled${skippedSuffix}`)}`,
  );
  console.log('');
  console.log(
    `  ${label('Manage:')} reef status ${namespace}/${manifest.name}`,
  );
  console.log(
    `  ${label('Remove:')} reef uninstall ${namespace}/${manifest.name}`,
  );
}
