#!/usr/bin/env node

import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspect } from './commands/inspect.js';
import { validate } from './commands/validate.js';
import { init } from './commands/init.js';
import { pack } from './commands/pack.js';
import { install } from './commands/install.js';
import { uninstall } from './commands/uninstall.js';
import { list } from './commands/list.js';
import { status } from './commands/status.js';
import { repair } from './commands/repair.js';
import { update } from './commands/update.js';
import { logs } from './commands/logs.js';
import { lock } from './commands/lock.js';
import { publish } from './commands/publish.js';
import { diff } from './commands/diff.js';
import { exportFormation } from './commands/export.js';
import { registerSearchCommand } from './commands/search.js';
import { registerTokenCommand } from './commands/token.js';
import { VERSION } from './version.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('reef')
    .description('OpenReef CLI — package and deploy multi-agent formations')
    .version(VERSION);

  program
    .command('init [name]')
    .description('Scaffold a new formation from the bundled template')
    .option('--name <name>', 'Formation name')
    .option('--namespace <namespace>', 'Namespace prefix')
    .option('--type <type>', 'Formation type (solo, shoal, school)', 'shoal')
    .option('--yes', 'Skip confirmation prompts')
    .action(async (name, options) => {
      try {
        await init(name, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('inspect <path>')
    .description('Parse reef.json and pretty-print formation contents')
    .action(async (path) => {
      try {
        await inspect(path);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('validate <path>')
    .description('Run schema and structural validation on a formation')
    .option('--quiet', 'Suppress output, exit code only')
    .option('--json', 'Output results as JSON')
    .option('--deployed', 'Validate deployed formation state instead of source')
    .action(async (path, options) => {
      try {
        const result = await validate(path, options);
        process.exit(result.valid ? 0 : 1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('pack <path>')
    .description('Package a formation into a .tar.gz archive')
    .option('--output <dir>', 'Output directory')
    .action(async (path, options) => {
      try {
        await pack(path, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('install <source>')
    .description('Deploy a formation (path, tarball, or registry name)')
    .option('--set <key=value...>', 'Set variable values')
    .option('--namespace <ns>', 'Override namespace (default: manifest.namespace)')
    .option('--force', 'Remove existing resources and recreate')
    .option('--merge', 'Update files only, preserve agent config')
    .option('--yes', 'Skip confirmation prompts')
    .option('--no-env', 'Skip loading .env file')
    .option('--dry-run', 'Preview changes without applying them')
    .option('--allow-channel-shadow', 'Allow bare bindings that shadow the main agent')
    .option('--registry <url>', 'Registry URL')
    .option('--skip-cache', 'Skip registry cache')
    .option('--gateway-url <url>', 'Gateway WebSocket URL')
    .option('--gateway-token <token>', 'Gateway auth token')
    .option('--gateway-password <password>', 'Gateway auth password')
    .action(async (source, options) => {
      try {
        await install(source, {
          ...options,
          noEnv: options.env === false,
          registryUrl: options.registry,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('uninstall <identifier>')
    .description('Remove an installed formation (namespace/name or name)')
    .option('--yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying them')
    .option('--gateway-url <url>', 'Gateway WebSocket URL')
    .option('--gateway-token <token>', 'Gateway auth token')
    .option('--gateway-password <password>', 'Gateway auth password')
    .action(async (identifier, options) => {
      try {
        await uninstall(identifier, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('update <source>')
    .description('Update an installed formation (path, tarball, or registry name)')
    .option('--set <key=value...>', 'Set variable values')
    .option('--namespace <ns>', 'Override namespace')
    .option('--yes', 'Skip confirmation')
    .option('--no-env', 'Skip loading .env file')
    .option('--dry-run', 'Preview changes without applying them')
    .option('--allow-channel-shadow', 'Allow bare bindings that shadow the main agent')
    .option('--registry <url>', 'Registry URL')
    .option('--skip-cache', 'Skip registry cache')
    .option('--gateway-url <url>', 'Gateway WebSocket URL')
    .option('--gateway-token <token>', 'Gateway auth token')
    .option('--gateway-password <password>', 'Gateway auth password')
    .action(async (source, options) => {
      try {
        await update(source, {
          ...options,
          noEnv: options.env === false,
          registryUrl: options.registry,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('repair <identifier>')
    .description('Detect and fix discrepancies in an installed formation')
    .option('--source <path>', 'Formation source for file re-deployment')
    .option('--yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying them')
    .option('--gateway-url <url>', 'Gateway WebSocket URL')
    .option('--gateway-token <token>', 'Gateway auth token')
    .option('--gateway-password <password>', 'Gateway auth password')
    .action(async (identifier, options) => {
      try {
        await repair(identifier, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('logs <identifier>')
    .description('View session logs for a formation')
    .option('--agent <slug>', 'Filter by agent slug or ID')
    .option('--lines <n>', 'Number of lines to show', '50')
    .option('--follow', 'Follow log output (tail -f)')
    .option('--path <path>', 'Read from a specific log file')
    .action(async (identifier, options) => {
      try {
        await logs(identifier, {
          ...options,
          lines: parseInt(options.lines, 10),
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('list')
    .description('List installed formations')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await list(options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('status <identifier>')
    .description('Show status of an installed formation (namespace/name or name)')
    .option('--json', 'Output as JSON')
    .option('--gateway-url <url>', 'Gateway WebSocket URL')
    .option('--gateway-token <token>', 'Gateway auth token')
    .option('--gateway-password <password>', 'Gateway auth password')
    .action(async (identifier, options) => {
      try {
        await status(identifier, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('export <identifier>')
    .description('Export a deployed formation source to a local directory')
    .option('--output <dir>', 'Output directory (default: ./{formation-name})')
    .option('--force', 'Overwrite existing output directory')
    .action(async (identifier, options) => {
      try {
        await exportFormation(identifier, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('lock [path]')
    .description('Resolve and pin skill dependency versions')
    .option('--registry <url>', 'Skills registry URL')
    .option('--skip-cache', 'Skip registry cache')
    .action(async (path, options) => {
      try {
        await lock(path ?? '.', {
          registryUrl: options.registry,
          skipCache: options.skipCache,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('publish [path]')
    .description('Publish a formation to the Tide registry')
    .option('--token <token>', 'Tide API token (or set REEF_TOKEN)')
    .option('--registry <url>', 'Registry URL', 'https://tide.openreef.ai')
    .option('--yes', 'Skip confirmation prompts')
    .action(async (path, options) => {
      try {
        await publish(path ?? '.', options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  program
    .command('diff <source>')
    .description('Compare local formation source against deployed state')
    .option('--set <key=value...>', 'Set variable values')
    .option('--namespace <ns>', 'Override namespace')
    .option('--no-env', 'Skip loading .env file')
    .option('--registry <url>', 'Registry URL')
    .option('--skip-cache', 'Skip registry cache')
    .action(async (source, options) => {
      try {
        await diff(source, {
          ...options,
          noEnv: options.env === false,
          registryUrl: options.registry,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  registerSearchCommand(program);
  registerTokenCommand(program);

  return program;
}

// Only parse when run as CLI entry point (robust ESM check with symlink resolution)
const selfUrl = import.meta.url;
let isDirectRun = false;
try {
  if (process.argv[1]) {
    isDirectRun = selfUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  }
} catch {
  // Non-standard invocation (missing/virtual argv path) — default to not parsing
}
if (isDirectRun) {
  buildProgram().parse();
}
