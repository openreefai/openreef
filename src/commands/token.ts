import { Command } from 'commander';
import { execFile } from 'child_process';
import chalk from 'chalk';

export function registerTokenCommand(program: Command) {
  program
    .command('token')
    .description('Manage your Tide API token')
    .option('--registry <url>', 'Registry URL', 'https://tide.openreef.ai')
    .action(async (opts: { registry: string }) => {
      // Validate the registry URL to prevent command injection
      let parsed: URL;
      try {
        parsed = new URL(opts.registry);
      } catch {
        console.error(chalk.red('Invalid registry URL'));
        process.exit(1);
        return;
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error(chalk.red('Registry URL must use http or https'));
        process.exit(1);
        return;
      }

      const url = `${parsed.origin}/dashboard`;
      console.log(chalk.bold('Opening Tide dashboard for token management...\n'));
      console.log(`  ${chalk.cyan(url)}\n`);
      console.log('After generating a token, set it in your environment:');
      console.log(chalk.dim('  export REEF_TOKEN=reef_tok_...\n'));

      if (process.platform === 'win32') {
        execFile('cmd.exe', ['/c', 'start', '', url]);
      } else {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execFile(cmd, [url]);
      }
    });
}
