import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validateFn: any = null;

async function getValidator() {
  if (validateFn) return validateFn;

  const ajvMod = await import('ajv/dist/2020.js');
  const formatsMod = await import('ajv-formats');

  const Ajv2020 = ajvMod.default?.default ?? ajvMod.default ?? ajvMod;
  const addFormats = formatsMod.default?.default ?? formatsMod.default ?? formatsMod;

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const currentFile = fileURLToPath(import.meta.url);
  const schemaPath = resolve(dirname(currentFile), '..', 'reef.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  validateFn = ajv.compile(schema);
  return validateFn;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

export async function validateManifest(data: unknown): Promise<ManifestValidationResult> {
  const validate = await getValidator();
  const valid = validate(data) as boolean;

  if (valid) {
    return { valid: true, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errors = (validate.errors ?? []).map((err: any) =>
    `${err.instancePath || '/'} ${err.message ?? 'unknown error'}`
  );

  return { valid: false, errors };
}
