import { resolve } from 'node:path';
import { loadManifest, ManifestLoadError } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { validateStructure } from '../core/structural-validator.js';
import { icons } from '../utils/output.js';
import type { ValidationResult, ValidationIssue } from '../types/validation.js';

export interface ValidateOptions {
  quiet?: boolean;
  json?: boolean;
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

export async function validate(
  path: string,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
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

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (options.quiet) {
    return result;
  }

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

  return result;
}
