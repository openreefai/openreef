import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { resolveGatewayUrl, resolveWorkspacePath } from '../core/openclaw-paths.js';
import {
  readConfig,
  writeConfig,
  addAgentEntry,
  addBinding,
  setAgentToAgent,
} from '../core/config-patcher.js';
import { GatewayClient, resolveGatewayAuth, type CronJob } from '../core/gateway-client.js';
import { saveState, computeFileHash } from '../core/state-manager.js';
import { loadManifest } from '../core/manifest-loader.js';
import { interpolate } from '../core/template-interpolator.js';
import { listFiles } from '../utils/fs.js';
import { collectDiscrepancies, type Discrepancy } from '../core/state-differ.js';
import { icons, header, label, value, table } from '../utils/output.js';
import {
  resolveFormationState,
  FormationNotFoundError,
  AmbiguousFormationError,
} from '../utils/identifiers.js';
import type { FormationState } from '../types/state.js';

const TOKEN_RE = /\{\{\w+\}\}/;

function isBinaryBuffer(buf: Buffer): boolean {
  const check = buf.subarray(0, 8192);
  return check.includes(0);
}

/**
 * Build a safe variables map for interpolation during repair.
 * State stores sensitive vars as "$NAME" placeholders — resolve those
 * from process.env to avoid injecting literal placeholder strings.
 */
function buildSafeVariables(stateVars: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, val] of Object.entries(stateVars)) {
    if (val.startsWith('$')) {
      const envVal = process.env[val.slice(1)];
      if (envVal !== undefined) {
        safe[name] = envVal;
      }
      // If not in env, omit — template token stays as {{NAME}}
    } else {
      safe[name] = val;
    }
  }
  return safe;
}

export interface RepairOptions {
  source?: string;
  yes?: boolean;
  dryRun?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
}

export async function repair(
  identifier: string,
  options: RepairOptions,
): Promise<void> {
  // 1. Resolve formation state
  let state: FormationState;
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

  // 2. Read config
  const { config, path: configPath } = await readConfig();

  // 3. Try to get live cron jobs
  let liveCronJobs: CronJob[] | null = null;
  if (state.cronJobs.length > 0) {
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
      liveCronJobs = await gw.cronList({ includeDisabled: true });
      gw.close();
    } catch {
      console.log(
        `${icons.warning} ${chalk.yellow('Gateway not reachable — cannot verify cron jobs')}`,
      );
    }
  }

  // 4. Collect discrepancies
  const discrepancies = collectDiscrepancies(state, config, liveCronJobs);

  if (discrepancies.length === 0) {
    console.log(
      `${icons.success} ${chalk.green('All resources healthy — nothing to repair')}`,
    );
    return;
  }

  // 5. Print discrepancy table
  console.log('');
  console.log(header('Discrepancies found'));
  console.log('');

  const rows: string[][] = [
    [chalk.dim('KIND'), chalk.dim('TYPE'), chalk.dim('DESCRIPTION'), chalk.dim('FIX')],
  ];
  for (const d of discrepancies) {
    const fix = d.fixable
      ? chalk.green('auto (from state)')
      : d.needsSource
        ? chalk.yellow('--source required')
        : chalk.red('manual');
    rows.push([d.kind, d.type, d.description, fix]);
  }
  console.log(table(rows));

  // 6. Dry run
  if (options.dryRun) {
    console.log('');
    console.log(label('Dry run — no changes applied.'));
    return;
  }

  // 7. Confirm
  if (!options.yes) {
    console.log('');
    const { confirm } = await import('@inquirer/prompts');
    const ok = await confirm({
      message: 'Repair these discrepancies?',
    });
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 8. Fix discrepancies
  const spinner = ora('Repairing formation...').start();
  let configModified = false;
  let stateModified = false;
  let fullyRepaired = 0;
  let partiallyRepaired = 0;
  let needsSource = 0;

  let patchedConfig = config;

  for (const d of discrepancies) {
    if (d.kind === 'agent' && d.type === 'missing' && d.fixable) {
      // Restore agent to config from state data
      const agent = Object.values(state.agents).find((a) => a.id === d.agentId);
      if (agent) {
        patchedConfig = addAgentEntry(patchedConfig, {
          id: agent.id,
          name: agent.slug,
          workspace: agent.workspace,
          model: typeof agent.model === 'string' ? agent.model : undefined,
          tools: agent.configTools,
          sandbox: agent.configSandbox,
          identity: agent.configIdentity,
          skills: agent.configSkills,
        });
        configModified = true;
        fullyRepaired++;
      }
    } else if (d.kind === 'binding' && d.type === 'missing' && d.fixable) {
      // Restore binding from state
      const binding = state.bindings.find((b) =>
        d.description.includes(b.match.channel) && d.description.includes(b.agentId),
      );
      if (binding) {
        patchedConfig = addBinding(patchedConfig, binding);
        configModified = true;
        fullyRepaired++;
      }
    } else if (d.kind === 'a2a' && d.type === 'missing' && d.fixable) {
      patchedConfig = setAgentToAgent(patchedConfig, state.namespace);
      configModified = true;
      fullyRepaired++;
    } else if (d.kind === 'cron' && d.type === 'missing' && d.fixable) {
      // Restore cron job from state
      const job = state.cronJobs.find((j) => d.description.includes(j.id));
      if (job && job.schedule && job.prompt) {
        try {
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
          await gw.connect();
          const agentId = Object.values(state.agents).find(
            (a) => a.slug === job.agentSlug,
          )?.id;
          if (agentId) {
            const result = await gw.cronAdd({
              name: job.name,
              agentId,
              enabled: true,
              schedule: {
                kind: 'cron',
                expr: job.schedule,
                tz: job.timezone,
              },
              sessionTarget: 'isolated',
              wakeMode: 'now',
              payload: {
                kind: 'agentTurn',
                message: job.prompt,
              },
            });
            // Update state with new cron ID
            const stateJob = state.cronJobs.find((j) => j.id === job.id);
            if (stateJob) {
              stateJob.id = result.id;
              stateModified = true;
            }
            fullyRepaired++;
          }
          gw.close();
        } catch {
          spinner.warn(`Could not restore cron job ${job.name}`);
        }
      }
    } else if (d.kind === 'file' && d.needsSource) {
      if (options.source) {
        // Re-deploy files from source
        const agent = Object.values(state.agents).find((a) => a.id === d.agentId);
        if (agent) {
          try {
            const manifest = await loadManifest(options.source);
            const agentDef = manifest.agents[agent.slug];
            if (agentDef) {
              const sourceDir = join(options.source, agentDef.source);
              await mkdir(agent.workspace, { recursive: true });

              const safeVars = buildSafeVariables(state.variables);

              if (d.description.includes('Workspace')) {
                // Re-deploy all files
                const files = await listFiles(sourceDir);
                for (const relativePath of files) {
                  const srcFile = join(sourceDir, relativePath);
                  const destPath = join(agent.workspace, relativePath);
                  await mkdir(dirname(destPath), { recursive: true });
                  const rawBytes = await readFile(srcFile);

                  if (isBinaryBuffer(rawBytes)) {
                    await writeFile(destPath, rawBytes);
                    state.fileHashes[`${agent.id}:${relativePath}`] =
                      computeFileHash(rawBytes);
                  } else {
                    let content = rawBytes.toString('utf-8');
                    if (TOKEN_RE.test(content)) {
                      content = interpolate(content, safeVars);
                    }
                    const written = Buffer.from(content, 'utf-8');
                    await writeFile(destPath, written);
                    state.fileHashes[`${agent.id}:${relativePath}`] =
                      computeFileHash(written);
                  }
                }
                stateModified = true;
                fullyRepaired++;
              } else {
                // Re-deploy specific file
                const fileMatch = d.description.match(/File (.+) (?:missing|changed) /);
                if (fileMatch) {
                  const relativePath = fileMatch[1];
                  const srcFile = join(sourceDir, relativePath);
                  const destPath = join(agent.workspace, relativePath);
                  await mkdir(dirname(destPath), { recursive: true });
                  const rawBytes = await readFile(srcFile);

                  if (isBinaryBuffer(rawBytes)) {
                    await writeFile(destPath, rawBytes);
                    state.fileHashes[`${agent.id}:${relativePath}`] =
                      computeFileHash(rawBytes);
                  } else {
                    let content = rawBytes.toString('utf-8');
                    if (TOKEN_RE.test(content)) {
                      content = interpolate(content, safeVars);
                    }
                    const written = Buffer.from(content, 'utf-8');
                    await writeFile(destPath, written);
                    state.fileHashes[`${agent.id}:${relativePath}`] =
                      computeFileHash(written);
                  }
                  stateModified = true;
                  fullyRepaired++;
                }
              }
            }
          } catch {
            // Source file may not match — partial fix
            partiallyRepaired++;
          }
        }
      } else if (d.description.includes('Workspace')) {
        // Partial fix: create the directory so subsequent --source can fill it
        const agent = Object.values(state.agents).find((a) => a.id === d.agentId);
        if (agent) {
          await mkdir(agent.workspace, { recursive: true });
          partiallyRepaired++;
        }
      } else {
        needsSource++;
      }
    } else if (!d.fixable) {
      needsSource++;
    }
  }

  // 9. Write config if modified
  if (configModified) {
    await writeConfig(configPath, patchedConfig, { silent: true });
  }

  // 10. Save state if modified
  if (stateModified) {
    await saveState(state);
  }

  spinner.succeed('Repair complete');
  console.log('');

  const parts: string[] = [];
  if (fullyRepaired > 0) parts.push(`${fullyRepaired} fully repaired`);
  if (partiallyRepaired > 0) parts.push(`${partiallyRepaired} partially repaired`);
  if (needsSource > 0) parts.push(`${needsSource} require --source`);

  console.log(`${icons.success} ${chalk.green(parts.join('. ') + '.')}`);
}
