import { join } from 'node:path';
import type { ReefManifest } from '../types/manifest.js';
import type { ValidationResult, ValidationIssue } from '../types/validation.js';
import { isDirectory } from '../utils/fs.js';
import { scanVariableTokens } from '../utils/fs.js';
import { normalizeToolName, isRecognizedTool, getAliasTarget } from './tool-names.js';

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
          message: `Binding for channel "${binding.match.channel}" references unknown agent "${binding.agent}"`,
          path: 'bindings',
        });
      }
    }
  }

  // Warning: binding match fields reference undeclared variables
  if (manifest.bindings) {
    const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;
    const bindingDeclaredVars = new Set(Object.keys(manifest.variables ?? {}));
    const bindingBuiltinVars = new Set(['namespace']);

    for (const [i, binding] of manifest.bindings.entries()) {
      // Collect all string fields from the match object to scan for tokens
      const matchStrings: { field: string; value: string }[] = [
        { field: 'channel', value: binding.match.channel },
      ];
      if (binding.match.accountId) matchStrings.push({ field: 'accountId', value: binding.match.accountId });
      if (binding.match.peer?.kind) matchStrings.push({ field: 'peer.kind', value: binding.match.peer.kind });
      if (binding.match.peer?.id) matchStrings.push({ field: 'peer.id', value: binding.match.peer.id });
      if (binding.match.guildId) matchStrings.push({ field: 'guildId', value: binding.match.guildId });
      if (binding.match.teamId) matchStrings.push({ field: 'teamId', value: binding.match.teamId });

      for (const { field, value } of matchStrings) {
        let match: RegExpExecArray | null;
        TOKEN_PATTERN.lastIndex = 0;
        while ((match = TOKEN_PATTERN.exec(value)) !== null) {
          const varName = match[1];
          if (!bindingDeclaredVars.has(varName) && !bindingBuiltinVars.has(varName)) {
            issues.push({
              severity: 'warning',
              code: 'UNDECLARED_BINDING_VARIABLE',
              message: `Binding match.${field} "${value}" references undeclared variable "{{${varName}}}"`,
              path: `bindings[${i}].match.${field}`,
            });
          }
        }
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

  // Tool name validation: check tools.allow entries for each agent
  for (const [slug, agent] of Object.entries(manifest.agents)) {
    if (!agent.tools?.allow) continue;
    for (const toolName of agent.tools.allow) {
      const aliasTarget = getAliasTarget(toolName);
      if (aliasTarget) {
        // Name is a known alias — suggest canonical name
        issues.push({
          severity: 'info',
          code: 'TOOL_NAME_ALIAS',
          message: `Agent "${slug}" uses tool alias "${toolName}" (normalized to "${aliasTarget}"). Consider using canonical name "${aliasTarget}".`,
          path: `agents.${slug}.tools.allow`,
        });
      } else if (!isRecognizedTool(toolName)) {
        // Completely unrecognized — could be a plugin tool
        issues.push({
          severity: 'warning',
          code: 'TOOL_NAME_UNRECOGNIZED',
          message: `Agent "${slug}" uses unrecognized tool name "${toolName}". This may be a plugin tool or a typo.`,
          path: `agents.${slug}.tools.allow`,
        });
      }
    }
  }

  // Duplicate binding detection: check for exact duplicate match objects targeting different agents
  if (manifest.bindings && manifest.bindings.length > 1) {
    const matchMap = new Map<string, string>();
    for (const binding of manifest.bindings) {
      const key = JSON.stringify(binding.match);
      const existing = matchMap.get(key);
      if (existing && existing !== binding.agent) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_BINDING',
          message: `Duplicate binding match ${key} targets both "${existing}" and "${binding.agent}"`,
          path: 'bindings',
        });
      } else {
        matchMap.set(key, binding.agent);
      }
    }
  }

  // A2A topology + sessions_send check
  if (manifest.agentToAgent) {
    for (const [source, targets] of Object.entries(manifest.agentToAgent)) {
      if (targets.length === 0) continue;
      const agent = manifest.agents[source];
      if (!agent) continue; // Already flagged by AGENT_REF_INVALID check
      const allowedTools = agent.tools?.allow ?? [];
      const normalizedAllowed = new Set(allowedTools.map(normalizeToolName));
      if (!normalizedAllowed.has('sessions_send')) {
        for (const target of targets) {
          issues.push({
            severity: 'warning',
            code: 'A2A_MISSING_SESSIONS_SEND',
            message: `Agent "${source}" communicates with "${target}" via agentToAgent but doesn't have "sessions_send" in tools.allow`,
            path: `agents.${source}.tools.allow`,
          });
        }
      }
    }
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}
