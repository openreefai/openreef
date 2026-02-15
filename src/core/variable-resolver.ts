import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { Variable } from '../types/manifest.js';

export interface ResolveOptions {
  cliOverrides?: Record<string, string>;
  envFilePath?: string;
  interactive?: boolean;
  noEnv?: boolean;
}

export interface ResolveResult {
  resolved: Record<string, string>;
  missing: string[];
}

export async function resolveVariables(
  variables: Record<string, Variable>,
  formationDir: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  // Load .env file if present (skip with --no-env)
  let envFileVars: Record<string, string> = {};
  if (!options.noEnv) {
    const envPath = options.envFilePath ?? join(formationDir, '.env');
    try {
      const envContent = await readFile(envPath, 'utf-8');
      envFileVars = parseDotenv(Buffer.from(envContent));
    } catch {
      // .env file not found — that's fine
    }
  }

  for (const [name, config] of Object.entries(variables)) {
    // Precedence: CLI > .env > env > defaults
    if (options.cliOverrides?.[name] !== undefined) {
      resolved[name] = options.cliOverrides[name];
    } else if (envFileVars[name] !== undefined) {
      resolved[name] = envFileVars[name];
    } else if (process.env[name] !== undefined) {
      resolved[name] = process.env[name]!;
    } else if (config.default !== undefined) {
      resolved[name] = String(config.default);
    } else if (config.required) {
      if (options.interactive) {
        const { input, password } = await import('@inquirer/prompts');
        const promptFn = config.sensitive ? password : input;
        const answer = await promptFn({
          message: `${name}${config.description ? ` (${config.description})` : ''}:`,
        });
        resolved[name] = answer;
      } else {
        missing.push(name);
      }
    }
  }

  return { resolved, missing };
}
