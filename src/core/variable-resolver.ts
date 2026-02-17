import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { Variable } from '../types/manifest.js';
import { getVariableHint } from './variable-hints.js';
import type { VariableHintContext } from './variable-hints.js';
import { promptChannel } from './channel-prompt.js';

export interface ResolveOptions {
  cliOverrides?: Record<string, string>;
  envFilePath?: string;
  interactive?: boolean;
  noEnv?: boolean;
  /** Environment snapshot — used for env var lookup and passed to hints. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Allow hints to spawn external processes (e.g., openclaw channels add). */
  allowExternalCommands?: boolean;
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
  const env = options.env ?? process.env;

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

  // Build hint context once (shared across all variables)
  const hintContext: VariableHintContext = {
    formationPath: formationDir,
    env,
    interactive: !!options.interactive,
    allowExternalCommands: !!options.allowExternalCommands,
    allowConfigMutation: false,
  };

  for (const [name, config] of Object.entries(variables)) {
    // Precedence: CLI > .env > env > defaults
    if (options.cliOverrides?.[name] !== undefined) {
      resolved[name] = options.cliOverrides[name];
    } else if (envFileVars[name] !== undefined) {
      resolved[name] = envFileVars[name];
    } else if (env[name] !== undefined) {
      resolved[name] = env[name]!;
    } else if (config.default !== undefined) {
      resolved[name] = String(config.default);
    } else if (options.interactive) {
      // Interactive: hints fire for ALL unresolved vars (required AND optional).
      // Plain prompt fallback only fires for required vars.
      const hint = await getVariableHint(name, config, hintContext);

      if (hint?.kind === 'channel') {
        resolved[name] = await promptChannel(name, config, hint, {
          allowExternalCommands: !!options.allowExternalCommands,
          isTTY: !!process.stdout?.isTTY,
        });
      } else if (hint?.kind === 'prefill') {
        const { input } = await import('@inquirer/prompts');
        console.log(`  ℹ GitHub: authenticated as ${hint.defaultValue} (via ${hint.source})`);
        const answer = await input({
          message: `${name}${config.description ? ` (${config.description})` : ''}:`,
          default: hint.defaultValue,
        });
        resolved[name] = answer;
      } else if (config.required) {
        // Existing behavior — plain input/password for required vars only
        const { input, password } = await import('@inquirer/prompts');
        const promptFn = config.sensitive ? password : input;
        const answer = await promptFn({
          message: `${name}${config.description ? ` (${config.description})` : ''}:`,
        });
        resolved[name] = answer;
      }
      // Optional var with no hint: silently skip (existing behavior preserved)
    } else if (config.required) {
      missing.push(name);
    }
  }

  return { resolved, missing };
}
