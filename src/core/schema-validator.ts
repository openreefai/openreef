import { readFileSync } from 'node:fs';
import { getSchemaPath } from '../utils/paths.js';
import type { ValidationResult } from '../types/validation.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validateFn: any = null;

async function getValidator() {
  if (validateFn) return validateFn;

  // Dynamic imports to handle CJS/ESM interop cleanly
  const ajvMod = await import('ajv/dist/2020.js');
  const formatsMod = await import('ajv-formats');

  const Ajv2020 = ajvMod.default?.default ?? ajvMod.default ?? ajvMod;
  const addFormats = formatsMod.default?.default ?? formatsMod.default ?? formatsMod;

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const schemaPath = getSchemaPath();
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  validateFn = ajv.compile(schema);
  return validateFn;
}

export async function validateSchema(data: unknown): Promise<ValidationResult> {
  const validate = await getValidator();
  const valid = validate(data) as boolean;

  if (valid) {
    return { valid: true, issues: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issues = (validate.errors ?? []).map((err: any) => ({
    severity: 'error' as const,
    code: 'SCHEMA_ERROR',
    message: `${err.instancePath || '/'} ${err.message ?? 'unknown error'}`,
    path: err.instancePath || '/',
  }));

  return { valid: false, issues };
}
