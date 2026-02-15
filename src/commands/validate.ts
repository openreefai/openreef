import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadManifest, ManifestLoadError } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { validateStructure } from '../core/structural-validator.js';
import { computeFileHash } from '../core/state-manager.js';
import { readConfig } from '../core/config-patcher.js';
import { icons } from '../utils/output.js';
import {
  resolveFormationState,
  FormationNotFoundError,
  AmbiguousFormationError,
} from '../utils/identifiers.js';
import type { ValidationResult, ValidationIssue } from '../types/validation.js';

export interface ValidateOptions {
  quiet?: boolean;
  json?: boolean;
  deployed?: boolean;
}

function mergeResults(...results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((r) => r.issues);
  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

function severityIcon(severity: ValidationIssue['severity']): string {
  switch (severity) {
    case 'error':
      return icons.error;
    case 'warning':
      return icons.warning;
    case 'info':
      return icons.info;
  }
}

function reportResult(result: ValidationResult, options: ValidateOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (options.quiet) return;

  if (result.valid && result.issues.length === 0) {
    console.log(`${icons.success} Formation is valid`);
  } else if (result.valid) {
    console.log(`${icons.success} Formation is valid (with warnings)`);
  } else {
    console.log(`${icons.error} Formation has validation errors`);
  }

  for (const issue of result.issues) {
    const pathStr = issue.path ? ` (${issue.path})` : '';
    console.log(`  ${severityIcon(issue.severity)} ${issue.message}${pathStr}`);
  }
}

export async function validate(
  path: string,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  if (options.deployed) {
    return validateDeployed(path, options);
  }

  const formationDir = resolve(path);

  let manifest;
  try {
    manifest = await loadManifest(formationDir);
  } catch (err) {
    if (err instanceof ManifestLoadError) {
      const result: ValidationResult = {
        valid: false,
        issues: [
          {
            severity: 'error',
            code: 'MANIFEST_LOAD_ERROR',
            message: err.message,
            path: 'reef.json',
          },
        ],
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!options.quiet) {
        console.error(`${icons.error} ${err.message}`);
      }
      return result;
    }
    throw err;
  }

  const schemaResult = await validateSchema(manifest);
  const structuralResult = await validateStructure(manifest, formationDir);
  const result = mergeResults(schemaResult, structuralResult);

  reportResult(result, options);
  return result;
}

async function validateDeployed(
  identifier: string,
  options: ValidateOptions,
): Promise<ValidationResult> {
  // 1. Resolve formation state
  let state;
  try {
    state = await resolveFormationState(identifier);
  } catch (err) {
    if (err instanceof FormationNotFoundError) {
      const result: ValidationResult = {
        valid: false,
        issues: [
          {
            severity: 'error',
            code: 'FORMATION_NOT_FOUND',
            message: err.message,
          },
        ],
      };
      reportResult(result, options);
      return result;
    }
    if (err instanceof AmbiguousFormationError) {
      const result: ValidationResult = {
        valid: false,
        issues: [
          {
            severity: 'error',
            code: 'AMBIGUOUS_FORMATION',
            message: `Multiple formations match "${identifier}". Specify the full namespace/name.`,
          },
        ],
      };
      reportResult(result, options);
      return result;
    }
    throw err;
  }

  const issues: ValidationIssue[] = [];

  // 2. State consistency checks
  for (const [slug, agent] of Object.entries(state.agents)) {
    // Agent workspaces exist on disk
    if (!existsSync(agent.workspace)) {
      issues.push({
        severity: 'error',
        code: 'WORKSPACE_MISSING',
        message: `Agent "${slug}" workspace missing: ${agent.workspace}`,
        path: `agents.${slug}.workspace`,
      });
      continue; // Skip file checks if workspace is gone
    }

    // Files in agent.files exist in their workspaces
    for (const file of agent.files) {
      const filePath = resolve(agent.workspace, file);
      if (!existsSync(filePath)) {
        issues.push({
          severity: 'error',
          code: 'FILE_MISSING',
          message: `File "${file}" missing from agent "${slug}" workspace`,
          path: `agents.${slug}.files`,
        });
        continue;
      }

      // File contents match fileHashes (detect drift)
      const hashKey = `${agent.id}:${file}`;
      const expectedHash = state.fileHashes[hashKey];
      if (expectedHash) {
        const content = await readFile(filePath);
        const actualHash = computeFileHash(content);
        if (actualHash !== expectedHash) {
          issues.push({
            severity: 'error',
            code: 'FILE_HASH_DRIFT',
            message: `File "${file}" in agent "${slug}" has been modified since deployment`,
            path: `agents.${slug}.files`,
          });
        }
      }
    }
  }

  // Bindings reference valid agent IDs
  const agentIds = new Set(
    Object.values(state.agents).map((a) => a.id),
  );
  for (const binding of state.bindings) {
    if (!agentIds.has(binding.agentId)) {
      issues.push({
        severity: 'error',
        code: 'BINDING_INVALID_AGENT',
        message: `Binding for channel "${binding.match.channel}" references non-existent agent "${binding.agentId}"`,
        path: 'bindings',
      });
    }
  }

  // Cron jobs reference valid agent slugs
  const agentSlugs = new Set(Object.keys(state.agents));
  for (const job of state.cronJobs) {
    if (!agentSlugs.has(job.agentSlug)) {
      issues.push({
        severity: 'error',
        code: 'CRON_INVALID_AGENT',
        message: `Cron job "${job.name}" references non-existent agent slug "${job.agentSlug}"`,
        path: 'cronJobs',
      });
    }
  }

  // 3. Config presence checks
  const { config } = await readConfig();
  const agentsList = (
    (config.agents as Record<string, unknown>)?.list as Record<string, unknown>[]
  ) ?? [];
  const configBindings = (config.bindings ?? []) as Record<string, unknown>[];

  for (const [slug, agent] of Object.entries(state.agents)) {
    const inConfig = agentsList.some((a) => a.id === agent.id);
    if (!inConfig) {
      issues.push({
        severity: 'error',
        code: 'AGENT_NOT_IN_CONFIG',
        message: `Agent "${slug}" (${agent.id}) not found in config agents.list`,
        path: `agents.${slug}`,
      });
    }
  }

  for (const binding of state.bindings) {
    const inConfig = configBindings.some((b) => {
      const match = b.match as Record<string, unknown> | undefined;
      return b.agentId === binding.agentId && match?.channel === binding.match.channel;
    });
    if (!inConfig) {
      issues.push({
        severity: 'error',
        code: 'BINDING_NOT_IN_CONFIG',
        message: `Binding ${binding.match.channel} → ${binding.agentId} not found in config bindings`,
        path: 'bindings',
      });
    }
  }

  // 4. Optional: if sourcePath exists, run offline validation too
  if (state.sourcePath && existsSync(state.sourcePath)) {
    try {
      const manifest = await loadManifest(state.sourcePath);
      const schemaResult = await validateSchema(manifest);
      const structResult = await validateStructure(manifest, state.sourcePath);
      const sourceIssues = [...schemaResult.issues, ...structResult.issues];
      // Downgrade to warnings — old installs without snapshots should not fail hard
      for (const issue of sourceIssues) {
        issues.push({
          ...issue,
          severity: 'warning',
          message: `[source] ${issue.message}`,
        });
      }
    } catch {
      // Source validation is optional — skip on error
    }
  }

  const result: ValidationResult = {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };

  reportResult(result, options);
  return result;
}
