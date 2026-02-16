import { Command } from 'commander';
import chalk from 'chalk';

export function registerSearchCommand(program: Command) {
  program
    .command('search <query>')
    .description('Search Tide for formations')
    .option('--type <type>', 'Filter by type (solo, shoal, school)')
    .option('--sort <sort>', 'Sort by (newest, downloads, stars)', 'newest')
    .option('--limit <n>', 'Max results', '10')
    .option('--registry <url>', 'Registry URL', 'https://tide.openreef.ai')
    .action(async (query: string, opts: { type?: string; sort: string; limit: string; registry: string }) => {
      const url = new URL('/api/formations', opts.registry);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', opts.limit);
      if (opts.type) url.searchParams.set('type', opts.type);
      url.searchParams.set('sort', opts.sort);

      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        console.error(chalk.red(`Search failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
        return;
      }

      if (!res.ok) {
        console.error(chalk.red(`Search failed: ${res.statusText}`));
        process.exit(1);
        return;
      }

      const { formations, total } = await res.json() as {
        formations: Array<{
          name: string;
          description?: string;
          type?: string;
          latest_version?: string;
          total_downloads?: number;
        }>;
        total: number;
      };

      console.log(chalk.dim(`${total} results for "${query}"\n`));

      for (const f of formations) {
        console.log(`${chalk.bold(f.name)} ${chalk.dim(`v${f.latest_version ?? '?'}`)}`);
        if (f.description) {
          console.log(`  ${f.description}`);
        }
        console.log(chalk.dim(`  ${f.type ?? 'unknown'} · ${f.total_downloads ?? 0} downloads\n`));
      }
    });
}
