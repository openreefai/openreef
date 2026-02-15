#!/usr/bin/env node

import { Command } from 'commander';
import { inspect } from './commands/inspect.js';
import { validate } from './commands/validate.js';
import { init } from './commands/init.js';
import { pack } from './commands/pack.js';

const program = new Command();

program
  .name('reef')
  .description('OpenReef CLI — package and deploy multi-agent formations')
  .version('0.1.0');

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

program.parse();
