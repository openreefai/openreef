import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install } from '../../src/commands/install.js';
import { repair } from '../../src/commands/repair.js';
import { removeAgentEntry, readConfig, writeConfig } from '../../src/core/config-patcher.js';

let tempHome: string;
let formationDir: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-repair-test-'));
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');

  await writeFile(
    join(tempHome, 'openclaw.json'),
    JSON.stringify({ agents: { list: [] }, bindings: [] }),
  );

  formationDir = join(tempHome, 'my-formation');
  await mkdir(formationDir, { recursive: true });
  await mkdir(join(formationDir, 'agents', 'triage'), { recursive: true });
  await writeFile(
    join(formationDir, 'agents', 'triage', 'SOUL.md'),
    'You are a triage agent.',
  );
  await writeFile(
    join(formationDir, 'reef.json'),
    JSON.stringify({
      reef: '1.0',
      type: 'solo',
      name: 'test-formation',
      version: '1.0.0',
      description: 'Test formation',
      namespace: 'testns',
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Handles triage',
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    }),
  );
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef repair', () => {
  it('reports healthy when nothing is wrong', async () => {
    await install(formationDir, { yes: true });
    // Repair should detect no discrepancies
    await repair('testns/test-formation', { yes: true });
    // No error thrown = success
  });

  it('repairs missing agent in config', async () => {
    await install(formationDir, { yes: true });

    // Manually remove agent from config
    const { config, path: configPath } = await readConfig(
      join(tempHome, 'openclaw.json'),
    );
    const cleaned = removeAgentEntry(config, 'testns-triage');
    await writeFile(configPath, JSON.stringify(cleaned, null, 2));

    // Repair should restore it
    await repair('testns/test-formation', { yes: true });

    // Verify agent is back in config
    const { config: afterConfig } = await readConfig(
      join(tempHome, 'openclaw.json'),
    );
    const list = (
      (afterConfig.agents as Record<string, unknown>).list as Record<
        string,
        unknown
      >[]
    );
    expect(list.some((a) => a.id === 'testns-triage')).toBe(true);
  });

  it('dry-run shows discrepancies without fixing', async () => {
    await install(formationDir, { yes: true });

    // Remove agent from config
    const { config, path: configPath } = await readConfig(
      join(tempHome, 'openclaw.json'),
    );
    const cleaned = removeAgentEntry(config, 'testns-triage');
    await writeFile(configPath, JSON.stringify(cleaned, null, 2));

    // Dry-run should not fix
    await repair('testns/test-formation', { dryRun: true });

    // Agent should still be missing
    const { config: afterConfig } = await readConfig(
      join(tempHome, 'openclaw.json'),
    );
    const list = (
      (afterConfig.agents as Record<string, unknown>).list as Record<
        string,
        unknown
      >[]
    );
    expect(list.some((a) => a.id === 'testns-triage')).toBe(false);
  });

  it('repairs missing workspace with --source', async () => {
    await install(formationDir, { yes: true });

    // Delete the workspace
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    await rm(workspaceDir, { recursive: true, force: true });
    expect(existsSync(workspaceDir)).toBe(false);

    // Repair with --source
    await repair('testns/test-formation', {
      yes: true,
      source: formationDir,
    });

    // Workspace should be recreated
    expect(existsSync(workspaceDir)).toBe(true);
    expect(existsSync(join(workspaceDir, 'SOUL.md'))).toBe(true);
  });
});
