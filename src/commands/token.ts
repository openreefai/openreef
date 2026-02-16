import { Command } from 'commander';
import { execFile } from 'child_process';
import chalk from 'chalk';
import { storeToken, getStoredToken, removeToken, getCredentialsPath } from '../core/credentials.js';

const DEFAULT_REGISTRY = 'https://tide.openreef.ai';

function parseRegistry(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error(chalk.red('Invalid registry URL'));
    process.exit(1);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    console.error(chalk.red('Registry URL must use http or https'));
    process.exit(1);
  }
  return parsed.origin;
}

export function registerTokenCommand(program: Command) {
  // reef login — interactive login: opens dashboard, prompts for token, stores it
  const loginAction = async (opts: { registry: string }) => {
    const registry = parseRegistry(opts.registry);
    const dashboardUrl = `${registry}/dashboard`;

    console.log(chalk.bold('\n  Logging in to Tide\n'));
    console.log(`  1. Opening ${chalk.cyan(dashboardUrl)}`);
    console.log(`  2. Generate a token in the dashboard`);
    console.log(`  3. Paste it below\n`);

    // Open browser
    if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', dashboardUrl]);
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(cmd, [dashboardUrl]);
    }

    // Prompt for token
    const { password } = await import('@inquirer/prompts');
    const token = await password({ message: 'Paste your token:' });

    if (!token || !token.startsWith('reef_tok_')) {
      console.error(chalk.red('\n  Invalid token. Tokens start with reef_tok_'));
      process.exit(1);
    }

    await storeToken(registry, token);
    console.log(chalk.green(`\n  Logged in to ${registry}`));
    console.log(chalk.dim(`  Token stored in ${getCredentialsPath()}\n`));
  };

  program
    .command('login')
    .description('Log in to Tide — stores token in ~/.openreef/')
    .option('--registry <url>', 'Registry URL', DEFAULT_REGISTRY)
    .action(loginAction);

  // reef token — alias for login
  program
    .command('token')
    .description('Alias for reef login')
    .option('--registry <url>', 'Registry URL', DEFAULT_REGISTRY)
    .action(loginAction);

  // reef logout
  program
    .command('logout')
    .description('Remove stored Tide token')
    .option('--registry <url>', 'Registry URL', DEFAULT_REGISTRY)
    .action(async (opts: { registry: string }) => {
      const registry = parseRegistry(opts.registry);
      const existing = await getStoredToken(registry);
      if (!existing) {
        console.log(chalk.dim(`  Not logged in to ${registry}`));
        return;
      }
      await removeToken(registry);
      console.log(chalk.green(`  Logged out from ${registry}`));
    });

  // reef whoami
  program
    .command('whoami')
    .description('Show current Tide login status')
    .option('--registry <url>', 'Registry URL', DEFAULT_REGISTRY)
    .action(async (opts: { registry: string }) => {
      const registry = parseRegistry(opts.registry);
      const token = await getStoredToken(registry);
      if (!token) {
        console.log(chalk.dim(`  Not logged in to ${registry}`));
        console.log(chalk.dim(`  Run ${chalk.cyan('reef login')} to authenticate`));
        return;
      }
      console.log(`  ${chalk.green('Logged in')} to ${registry}`);
      console.log(chalk.dim(`  Token: ${token.slice(0, 13)}...`));
    });
}
