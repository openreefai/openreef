import { join } from 'node:path';
import type { ReefManifest } from '../types/manifest.js';
import type { ValidationResult, ValidationIssue } from '../types/validation.js';
import { isDirectory } from '../utils/fs.js';
import { scanVariableTokens } from '../utils/fs.js';

export async function validateStructure(
  manifest: ReefManifest,
  formationDir: string,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const agentSlugs = Object.keys(manifest.agents);

  // Check agent source directories and SOUL.md
  for (const [slug, agent] of Object.entries(manifest.agents)) {
    const agentDir = join(formationDir, agent.source);
    if (!(await isDirectory(agentDir))) {
      issues.push({
        severity: 'error',
        code: 'AGENT_DIR_MISSING',
        message: `Agent "${slug}" source directory not found: ${agent.source}`,
        path: `agents.${slug}.source`,
      });
    } else {
      // Check for SOUL.md
      try {
        const { stat } = await import('node:fs/promises');
        const soulPath = join(agentDir, 'SOUL.md');
        await stat(soulPath);
      } catch {
        issues.push({
          severity: 'error',
          code: 'SOUL_MD_MISSING',
          message: `Agent "${slug}" is missing required SOUL.md in ${agent.source}`,
          path: `agents.${slug}.source`,
        });
      }
    }
  }

  // Check agentToAgent references
  if (manifest.agentToAgent) {
    for (const [source, targets] of Object.entries(manifest.agentToAgent)) {
      if (!agentSlugs.includes(source)) {
        issues.push({
          severity: 'error',
          code: 'AGENT_REF_INVALID',
          message: `agentToAgent source "${source}" is not a declared agent`,
          path: `agentToAgent.${source}`,
        });
      }
      for (const target of targets) {
        if (!agentSlugs.includes(target)) {
          issues.push({
            severity: 'error',
            code: 'AGENT_REF_INVALID',
            message: `agentToAgent target "${target}" (from "${source}") is not a declared agent`,
            path: `agentToAgent.${source}`,
          });
        }
      }
    }
  }

  // Check binding agent references
  if (manifest.bindings) {
    for (const binding of manifest.bindings) {
      if (!agentSlugs.includes(binding.agent)) {
        issues.push({
          severity: 'error',
          code: 'BINDING_REF_INVALID',
          message: `Binding for channel "${binding.channel}" references unknown agent "${binding.agent}"`,
          path: 'bindings',
        });
      }
    }
  }

  // Check cron agent references
  if (manifest.cron) {
    for (const job of manifest.cron) {
      if (!agentSlugs.includes(job.agent)) {
        issues.push({
          severity: 'error',
          code: 'CRON_REF_INVALID',
          message: `Cron job references unknown agent "${job.agent}"`,
          path: 'cron',
        });
      }
    }
  }

  // Warning: type/agent-count mismatch
  const agentCount = agentSlugs.length;
  if (manifest.type === 'solo' && agentCount !== 1) {
    issues.push({
      severity: 'warning',
      code: 'TYPE_COUNT_MISMATCH',
      message: `Formation type is "solo" but has ${agentCount} agent(s) (expected 1)`,
      path: 'type',
    });
  }
  if (manifest.type === 'shoal' && (agentCount < 2 || agentCount > 5)) {
    issues.push({
      severity: 'warning',
      code: 'TYPE_COUNT_MISMATCH',
      message: `Formation type is "shoal" but has ${agentCount} agent(s) (expected 2-5)`,
      path: 'type',
    });
  }
  if (manifest.type === 'school' && agentCount < 6) {
    issues.push({
      severity: 'warning',
      code: 'TYPE_COUNT_MISMATCH',
      message: `Formation type is "school" but has ${agentCount} agent(s) (expected 6+)`,
      path: 'type',
    });
  }

  // Warning: undeclared variable tokens in .md files
  const declaredVars = new Set(Object.keys(manifest.variables ?? {}));
  const builtinVars = new Set(['namespace', 'tools']);

  for (const [slug, agent] of Object.entries(manifest.agents)) {
    const agentDir = join(formationDir, agent.source);
    if (!(await isDirectory(agentDir))) continue;

    const tokens = await scanVariableTokens(agentDir);
    for (const token of tokens) {
      if (!declaredVars.has(token) && !builtinVars.has(token)) {
        issues.push({
          severity: 'warning',
          code: 'UNDECLARED_VARIABLE',
          message: `Agent "${slug}" references undeclared variable "{{${token}}}"`,
          path: `agents.${slug}`,
        });
      }
    }
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}
