import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install } from '../../src/commands/install.js';
import { update } from '../../src/commands/update.js';
import { readConfig, writeConfig } from '../../src/core/config-patcher.js';
import { loadState } from '../../src/core/state-manager.js';

let tempHome: string;
let formationDir: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-update-test-'));
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

describe('reef update', () => {
  it('reports already up to date when nothing changed', async () => {
    await install(formationDir, { yes: true });
    // Update with same manifest should show "already up to date"
    await update(formationDir, { yes: true });
    // No error = success
  });

  it('updates changed files', async () => {
    await install(formationDir, { yes: true });

    // Modify the source file
    await writeFile(
      join(formationDir, 'agents', 'triage', 'SOUL.md'),
      'You are an UPDATED triage agent.',
    );

    // Update
    await update(formationDir, { yes: true });

    // Verify workspace file was updated
    const content = await readFile(
      join(tempHome, 'workspace-testns-triage', 'SOUL.md'),
      'utf-8',
    );
    expect(content).toContain('UPDATED');

    // Verify state was updated
    const state = await loadState('testns', 'test-formation');
    expect(state?.updatedAt).toBeDefined();
  });

  it('adds new agent on update', async () => {
    await install(formationDir, { yes: true });

    // Add a new agent to the manifest
    await mkdir(join(formationDir, 'agents', 'researcher'), {
      recursive: true,
    });
    await writeFile(
      join(formationDir, 'agents', 'researcher', 'SOUL.md'),
      'You are a researcher.',
    );
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'shoal',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
          researcher: {
            source: 'agents/researcher',
            description: 'Does research',
          },
        },
      }),
    );

    await update(formationDir, { yes: true });

    // Verify new agent workspace exists
    const researcherWs = join(tempHome, 'workspace-testns-researcher');
    expect(existsSync(researcherWs)).toBe(true);
    expect(existsSync(join(researcherWs, 'SOUL.md'))).toBe(true);

    // Verify config has main + both agents
    const { config } = await readConfig(join(tempHome, 'openclaw.json'));
    const list = (
      (config.agents as Record<string, unknown>).list as Record<
        string,
        unknown
      >[]
    );
    expect(list).toHaveLength(3); // main + triage + researcher
    expect(list[0].id).toBe('main');

    // Verify state version updated
    const state = await loadState('testns', 'test-formation');
    expect(state?.version).toBe('1.1.0');
  });

  it('dry-run shows plan without applying', async () => {
    await install(formationDir, { yes: true });

    // Modify file
    await writeFile(
      join(formationDir, 'agents', 'triage', 'SOUL.md'),
      'Modified content.',
    );

    // Dry run
    await update(formationDir, { dryRun: true });

    // File should NOT have been updated
    const content = await readFile(
      join(tempHome, 'workspace-testns-triage', 'SOUL.md'),
      'utf-8',
    );
    expect(content).toBe('You are a triage agent.');
  });

  it('version bump is tracked in state', async () => {
    await install(formationDir, { yes: true });

    // Bump version only
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '2.0.0',
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

    await update(formationDir, { yes: true });

    const state = await loadState('testns', 'test-formation');
    expect(state?.version).toBe('2.0.0');
  });

  it('update --yes skips net-new bindings for unconfigured channels', async () => {
    // Install formation with a scoped telegram binding
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
        bindings: [{ channel: 'telegram:group-123', agent: 'triage' }],
      }),
    );
    await install(formationDir, { yes: true });

    // Add channels section to config — only telegram configured
    const configPath = join(tempHome, 'openclaw.json');
    const { config } = await readConfig(configPath);
    config.channels = { telegram: { enabled: true } };
    await writeConfig(configPath, config, { silent: true });

    // Update manifest to add an unconfigured slack binding alongside telegram
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { channel: 'telegram:group-123', agent: 'triage' },
          { channel: 'slack:#support', agent: 'triage' },
        ],
      }),
    );

    await update(formationDir, { yes: true });

    // Assert: config has only scoped telegram binding (slack not added — unconfigured)
    const { config: updatedConfig } = await readConfig(configPath);
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0] as Record<string, unknown>).match).toEqual({
      channel: 'telegram:group-123',
    });

    // Assert: state has only scoped telegram binding
    const state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(1);
    expect(state?.bindings[0].match.channel).toBe('telegram:group-123');
  });

  it('update --yes skips bare net-new bindings by default', async () => {
    // Install formation with a scoped telegram binding
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
        bindings: [{ channel: 'telegram:group-123', agent: 'triage' }],
      }),
    );
    await install(formationDir, { yes: true });

    // Add channels section to config
    const configPath = join(tempHome, 'openclaw.json');
    const { config } = await readConfig(configPath);
    config.channels = { telegram: { enabled: true } };
    await writeConfig(configPath, config, { silent: true });

    // Update manifest to add a bare telegram binding
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { channel: 'telegram:group-123', agent: 'triage' },
          { channel: 'telegram', agent: 'triage' },
        ],
      }),
    );

    await update(formationDir, { yes: true });

    // Assert: config has only the scoped binding (bare one skipped)
    const { config: updatedConfig } = await readConfig(configPath);
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0] as Record<string, unknown>).match).toEqual({
      channel: 'telegram:group-123',
    });
  });

  it('update --yes --allow-channel-shadow wires bare net-new bindings', async () => {
    // Install formation with a scoped telegram binding
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
        bindings: [{ channel: 'telegram:group-123', agent: 'triage' }],
      }),
    );
    await install(formationDir, { yes: true });

    // Add channels section
    const configPath = join(tempHome, 'openclaw.json');
    const { config } = await readConfig(configPath);
    config.channels = { telegram: { enabled: true } };
    await writeConfig(configPath, config, { silent: true });

    // Update manifest to add a bare telegram binding
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { channel: 'telegram:group-123', agent: 'triage' },
          { channel: 'telegram', agent: 'triage' },
        ],
      }),
    );

    await update(formationDir, { yes: true, allowChannelShadow: true });

    // Assert: config has both bindings
    const { config: updatedConfig } = await readConfig(configPath);
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(2);

    const channels = bindings.map(
      (b) => ((b as Record<string, unknown>).match as Record<string, unknown>).channel,
    );
    expect(channels).toContain('telegram:group-123');
    expect(channels).toContain('telegram');
  });

  it('update --yes wires net-new scoped bindings when no channels section (backward compat)', async () => {
    // Install formation with scoped telegram binding (no channels section)
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
        bindings: [{ channel: 'telegram:group-123', agent: 'triage' }],
      }),
    );
    await install(formationDir, { yes: true });

    // Update manifest to add a scoped slack binding alongside telegram
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { channel: 'telegram:group-123', agent: 'triage' },
          { channel: 'slack:#support', agent: 'triage' },
        ],
      }),
    );

    await update(formationDir, { yes: true });

    // Assert: config has both scoped bindings (configuredChannels null → all unknown → scoped kept)
    const configPath = join(tempHome, 'openclaw.json');
    const { config } = await readConfig(configPath);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(2);

    // Assert: state has both bindings
    const state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(2);
  });

  it('update is idempotent for templates with {{tools}}', async () => {
    // SOUL.md with tools token
    await writeFile(
      join(formationDir, 'agents', 'triage', 'SOUL.md'),
      'Tools:\n{{tools}}\nEnd.',
    );

    // Formation with tools and skills
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
            tools: { allow: ['web-search', 'calculator'] },
          },
        },
        dependencies: {
          skills: { 'web-search': '^1.2.0' },
        },
      }),
    );

    await install(formationDir, { yes: true });

    // Verify tools were interpolated
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    const soulContent = await readFile(join(workspaceDir, 'SOUL.md'), 'utf-8');
    expect(soulContent).toContain('- **web-search** (^1.2.0)');
    expect(soulContent).toContain('- **calculator**');

    // Second update with identical manifest should be no-op
    const state1 = await loadState('testns', 'test-formation');
    await update(formationDir, { yes: true });
    const state2 = await loadState('testns', 'test-formation');

    // File hashes should be identical — no perpetual "changed files"
    expect(state2?.fileHashes).toEqual(state1?.fileHashes);
  });
});
