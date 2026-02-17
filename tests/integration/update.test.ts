import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create as createTar } from 'tar';
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
        bindings: [{ match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' }],
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
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
          { match: { channel: 'slack', peer: { kind: 'channel', id: '#support' } }, agent: 'triage' },
        ],
      }),
    );

    await update(formationDir, { yes: true });

    // Assert: config has only scoped telegram binding (slack not added — unconfigured)
    const { config: updatedConfig } = await readConfig(configPath);
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0] as Record<string, unknown>).match).toEqual({
      channel: 'telegram', peer: { kind: 'group', id: 'group-123' },
    });

    // Assert: state has only scoped telegram binding
    const state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(1);
    expect(state?.bindings[0].match.channel).toBe('telegram');
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
        bindings: [{ match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' }],
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
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
          { match: { channel: 'telegram' }, agent: 'triage' },
        ],
      }),
    );

    await update(formationDir, { yes: true });

    // Assert: config has only the scoped binding (bare one skipped)
    const { config: updatedConfig } = await readConfig(configPath);
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0] as Record<string, unknown>).match).toEqual({
      channel: 'telegram', peer: { kind: 'group', id: 'group-123' },
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
        bindings: [{ match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' }],
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
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
          { match: { channel: 'telegram' }, agent: 'triage' },
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
    expect(channels).toContain('telegram');
    // Verify both bare and scoped are present
    const hasBare = bindings.some((b) => !((b as Record<string, unknown>).match as Record<string, unknown>).peer);
    const hasScoped = bindings.some((b) => !!((b as Record<string, unknown>).match as Record<string, unknown>).peer);
    expect(hasBare).toBe(true);
    expect(hasScoped).toBe(true);
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
        bindings: [{ match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' }],
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
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
          { match: { channel: 'slack', peer: { kind: 'channel', id: '#support' } }, agent: 'triage' },
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

  it('update detects no binding change when variable resolves to same value', async () => {
    // Install formation with a resolved binding via .env
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation',
        namespace: 'testns',
        variables: {
          INTERACTION_CHANNEL: { type: 'string' },
          INTERACTION_PEER_KIND: { type: 'string' },
          INTERACTION_PEER_ID: { type: 'string' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [{ match: { channel: '{{INTERACTION_CHANNEL}}', peer: { kind: '{{INTERACTION_PEER_KIND}}', id: '{{INTERACTION_PEER_ID}}' } }, agent: 'triage' }],
      }),
    );
    await writeFile(join(formationDir, '.env'), 'INTERACTION_CHANNEL=slack\nINTERACTION_PEER_KIND=channel\nINTERACTION_PEER_ID="#ops"');
    await install(formationDir, { yes: true });

    // Verify initial binding was wired
    let state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(1);
    expect(state?.bindings[0].match.channel).toBe('slack');

    // Update with same variable value — should be no-op for bindings
    await update(formationDir, { yes: true });

    const { config: updatedConfig } = await readConfig(join(tempHome, 'openclaw.json'));
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0] as Record<string, unknown>).match).toEqual({
      channel: 'slack', peer: { kind: 'channel', id: '#ops' },
    });
  });

  it('update detects binding change when variable resolves to different value', async () => {
    // Install formation with a resolved binding via .env
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation',
        namespace: 'testns',
        variables: {
          INTERACTION_CHANNEL: { type: 'string' },
          INTERACTION_PEER_KIND: { type: 'string' },
          INTERACTION_PEER_ID: { type: 'string' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [{ match: { channel: '{{INTERACTION_CHANNEL}}', peer: { kind: '{{INTERACTION_PEER_KIND}}', id: '{{INTERACTION_PEER_ID}}' } }, agent: 'triage' }],
      }),
    );
    await writeFile(join(formationDir, '.env'), 'INTERACTION_CHANNEL=slack\nINTERACTION_PEER_KIND=channel\nINTERACTION_PEER_ID="#ops"');
    await install(formationDir, { yes: true });

    // Now change the variable value
    await writeFile(join(formationDir, '.env'), 'INTERACTION_CHANNEL=telegram\nINTERACTION_PEER_KIND=group\nINTERACTION_PEER_ID=12345');

    // Bump version so update is not just a version-only change
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        variables: {
          INTERACTION_CHANNEL: { type: 'string' },
          INTERACTION_PEER_KIND: { type: 'string' },
          INTERACTION_PEER_ID: { type: 'string' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [{ match: { channel: '{{INTERACTION_CHANNEL}}', peer: { kind: '{{INTERACTION_PEER_KIND}}', id: '{{INTERACTION_PEER_ID}}' } }, agent: 'triage' }],
      }),
    );

    await update(formationDir, { yes: true });

    // Binding should now be telegram
    const { config: updatedConfig } = await readConfig(join(tempHome, 'openclaw.json'));
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0] as Record<string, unknown>).match).toEqual({
      channel: 'telegram', peer: { kind: 'group', id: '12345' },
    });

    // State should reflect the new binding
    const state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(1);
    expect(state?.bindings[0].match.channel).toBe('telegram');
  });

  it('update treats unresolved binding variable as absent (removes stale binding)', async () => {
    // Install formation with a resolved binding via .env
    // Use sensitive: true so state stores "$INTERACTION_CHANNEL" (env ref),
    // not the literal value — this ensures the state fallback doesn't restore it.
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation',
        namespace: 'testns',
        variables: {
          INTERACTION_CHANNEL: { type: 'string', sensitive: true },
          INTERACTION_PEER_KIND: { type: 'string', sensitive: true },
          INTERACTION_PEER_ID: { type: 'string', sensitive: true },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [{ match: { channel: '{{INTERACTION_CHANNEL}}', peer: { kind: '{{INTERACTION_PEER_KIND}}', id: '{{INTERACTION_PEER_ID}}' } }, agent: 'triage' }],
      }),
    );
    await writeFile(join(formationDir, '.env'), 'INTERACTION_CHANNEL=slack\nINTERACTION_PEER_KIND=channel\nINTERACTION_PEER_ID="#ops"');
    await install(formationDir, { yes: true });

    // Verify initial binding was wired
    let state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(1);
    expect(state?.bindings[0].match.channel).toBe('slack');

    // Remove the .env file so variable is unresolved, bump version
    await rm(join(formationDir, '.env'));
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.1.0',
        description: 'Test formation',
        namespace: 'testns',
        variables: {
          INTERACTION_CHANNEL: { type: 'string', sensitive: true },
          INTERACTION_PEER_KIND: { type: 'string', sensitive: true },
          INTERACTION_PEER_ID: { type: 'string', sensitive: true },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [{ match: { channel: '{{INTERACTION_CHANNEL}}', peer: { kind: '{{INTERACTION_PEER_KIND}}', id: '{{INTERACTION_PEER_ID}}' } }, agent: 'triage' }],
      }),
    );

    // Use --no-env to prevent any env file from being loaded
    await update(formationDir, { yes: true, noEnv: true });

    // Binding should be removed (not replaced with literal {{INTERACTION_CHANNEL}})
    const { config: updatedConfig } = await readConfig(join(tempHome, 'openclaw.json'));
    const bindings = updatedConfig.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(0);

    // State should have no bindings
    state = await loadState('testns', 'test-formation');
    expect(state?.bindings).toHaveLength(0);
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

// ── Registry update integration tests ──

describe('reef update (registry)', () => {
  let tempHome: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-reg-update-'));
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
    originalFetch = globalThis.fetch;

    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({ agents: { list: [] }, bindings: [] }),
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  async function createFormationTarball(
    name: string,
    version: string,
    namespace: string,
  ): Promise<{ tarballPath: string; sha256: string }> {
    const formDir = join(tempHome, `formation-${name}-${version}`);
    await mkdir(join(formDir, 'agents', 'worker'), { recursive: true });
    await writeFile(
      join(formDir, 'agents', 'worker', 'SOUL.md'),
      `You are a worker v${version}.`,
    );
    await writeFile(
      join(formDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name,
        version,
        description: `${name} formation`,
        namespace,
        agents: {
          worker: {
            source: 'agents/worker',
            description: 'Does work',
          },
        },
      }),
    );

    const tarballPath = join(tempHome, `${name}-${version}.reef.tar.gz`);
    await createTar({ gzip: true, file: tarballPath, cwd: formDir }, ['.']);
    const content = await readFile(tarballPath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    return { tarballPath, sha256 };
  }

  function mockTideFetch(
    _registryUrl: string,
    formations: Record<string, { latest: string; versions: Record<string, { sha256?: string }> }>,
    tarballs: Record<string, string>,
  ) {
    // Build a map from "name-version" to tarball path
    const tarballByNameVersion: Record<string, string> = {};
    for (const path of Object.values(tarballs)) {
      // Extract name-version from path like ".../formation-daily-ops-1.0.0/..."
      for (const [name, formation] of Object.entries(formations)) {
        for (const version of Object.keys(formation.versions)) {
          if (path.includes(`${name}-${version}`)) {
            tarballByNameVersion[`${name}:${version}`] = path;
          }
        }
      }
    }

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      // Match Tide API endpoints - check most specific first
      for (const [name, formation] of Object.entries(formations)) {
        // Download endpoint: /api/formations/:name/:version/download
        const downloadRe = new RegExp(`/api/formations/${name}/([^/]+)/download`);
        const downloadMatch = url.match(downloadRe);
        if (downloadMatch) {
          const version = downloadMatch[1];
          const tarballPath = tarballByNameVersion[`${name}:${version}`];
          if (tarballPath) {
            const content = await readFile(tarballPath);
            return {
              ok: true,
              arrayBuffer: () =>
                Promise.resolve(
                  content.buffer.slice(
                    content.byteOffset,
                    content.byteOffset + content.byteLength,
                  ),
                ),
            };
          }
          return { ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({ error: 'Not found' }) };
        }

        // Version detail endpoint: /api/formations/:name/:version (no trailing /download)
        const versionRe = new RegExp(`/api/formations/${name}/([^/?]+)$`);
        const versionMatch = url.match(versionRe);
        if (versionMatch) {
          const version = versionMatch[1];
          const versionData = formation.versions[version];
          if (versionData) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({
                name,
                version,
                sha256: versionData.sha256,
              }),
            };
          }
          return { ok: false, status: 404, json: () => Promise.resolve({ error: 'Version not found' }) };
        }

        // Formation detail endpoint: /api/formations/:name (exact match)
        const formationRe = new RegExp(`/api/formations/${name}$`);
        if (formationRe.test(url)) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              name,
              latest_version: formation.latest,
            }),
          };
        }
      }

      return { ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({ error: 'Not found' }) };
    }) as unknown as typeof fetch;
  }

  it('update via registry resolves bare name', async () => {
    const v1 = await createFormationTarball('daily-ops', '1.0.0', 'ops');
    const v2 = await createFormationTarball('daily-ops', '1.1.0', 'ops');

    const registryUrl = 'https://registry.example.com';

    // First install v1.0.0
    mockTideFetch(registryUrl, {
      'daily-ops': {
        latest: '1.0.0',
        versions: {
          '1.0.0': { sha256: v1.sha256 },
        },
      },
    }, { [v1.tarballPath]: v1.tarballPath });

    await install('daily-ops', {
      yes: true,
      registryUrl,
    });

    let state = await loadState('ops', 'daily-ops');
    expect(state?.version).toBe('1.0.0');
    expect(state?.registryRef).toEqual({ name: 'daily-ops', version: '1.0.0' });

    // Now update to v1.1.0
    mockTideFetch(registryUrl, {
      'daily-ops': {
        latest: '1.1.0',
        versions: {
          '1.0.0': { sha256: v1.sha256 },
          '1.1.0': { sha256: v2.sha256 },
        },
      },
    }, { [v2.tarballPath]: v2.tarballPath });

    await update('daily-ops', {
      yes: true,
      registryUrl,
      skipCache: true,
    });

    state = await loadState('ops', 'daily-ops');
    expect(state?.version).toBe('1.1.0');
    expect(state?.registryRef).toEqual({ name: 'daily-ops', version: '1.1.0' });
  });

  it('unverified tarball is always re-fetched', async () => {
    const v1 = await createFormationTarball('sketchy', '0.1.0', 'ops');

    const registryUrl = 'https://registry.example.com';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockTideFetch(registryUrl, {
      'sketchy': {
        latest: '0.1.0',
        versions: {
          '0.1.0': {
            // no sha256 — unverified
          },
        },
      },
    }, { [v1.tarballPath]: v1.tarballPath });

    await install('sketchy', {
      yes: true,
      registryUrl,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNVERIFIED'),
    );

    // Update — should re-download since unverified
    mockTideFetch(registryUrl, {
      'sketchy': {
        latest: '0.1.0',
        versions: {
          '0.1.0': {
            // no sha256 — unverified
          },
        },
      },
    }, { [v1.tarballPath]: v1.tarballPath });

    await update('sketchy', {
      yes: true,
      registryUrl,
      skipCache: true,
    });

    // The tarball download URL should have been fetched during update (download endpoint)
    const downloadCalls = vi.mocked(globalThis.fetch).mock.calls.filter(
      (c) => (c[0] as string).includes('/download'),
    );
    expect(downloadCalls.length).toBeGreaterThanOrEqual(1);

    warnSpy.mockRestore();
  });

  it('update from local after registry install clears registryRef', async () => {
    const v1 = await createFormationTarball('daily-ops', '1.0.0', 'ops');

    const registryUrl = 'https://registry.example.com';

    mockTideFetch(registryUrl, {
      'daily-ops': {
        latest: '1.0.0',
        versions: {
          '1.0.0': { sha256: v1.sha256 },
        },
      },
    }, { [v1.tarballPath]: v1.tarballPath });

    await install('daily-ops', {
      yes: true,
      registryUrl,
    });

    let state = await loadState('ops', 'daily-ops');
    expect(state?.registryRef).toEqual({ name: 'daily-ops', version: '1.0.0' });

    // Now update from a local directory — registryRef should be cleared
    const localDir = join(tempHome, 'local-daily-ops');
    await mkdir(join(localDir, 'agents', 'worker'), { recursive: true });
    await writeFile(
      join(localDir, 'agents', 'worker', 'SOUL.md'),
      'You are a LOCAL worker v2.',
    );
    await writeFile(
      join(localDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'daily-ops',
        version: '2.0.0',
        description: 'Local daily ops',
        namespace: 'ops',
        agents: {
          worker: {
            source: 'agents/worker',
            description: 'Does work',
          },
        },
      }),
    );

    // Restore original fetch — no registry should be used
    globalThis.fetch = originalFetch;

    await update(localDir, { yes: true });

    state = await loadState('ops', 'daily-ops');
    expect(state?.version).toBe('2.0.0');
    expect(state?.registryRef).toBeUndefined();
  });

  it('update from registry overwrites registryRef version', async () => {
    const v1 = await createFormationTarball('daily-ops', '1.0.0', 'ops');
    const v2 = await createFormationTarball('daily-ops', '2.0.0', 'ops');

    const registryUrl = 'https://registry.example.com';

    // Install v1
    mockTideFetch(registryUrl, {
      'daily-ops': {
        latest: '1.0.0',
        versions: {
          '1.0.0': { sha256: v1.sha256 },
        },
      },
    }, { [v1.tarballPath]: v1.tarballPath });
    await install('daily-ops', { yes: true, registryUrl });

    let state = await loadState('ops', 'daily-ops');
    expect(state?.registryRef?.version).toBe('1.0.0');

    // Update to v2 via registry
    mockTideFetch(registryUrl, {
      'daily-ops': {
        latest: '2.0.0',
        versions: {
          '1.0.0': { sha256: v1.sha256 },
          '2.0.0': { sha256: v2.sha256 },
        },
      },
    }, { [v2.tarballPath]: v2.tarballPath });
    await update('daily-ops', { yes: true, registryUrl, skipCache: true });

    state = await loadState('ops', 'daily-ops');
    expect(state?.registryRef).toEqual({ name: 'daily-ops', version: '2.0.0' });
  });

  it('local directory takes precedence in update', async () => {
    // First install from local dir
    const localDir = join(tempHome, 'daily-ops');
    await mkdir(join(localDir, 'agents', 'worker'), { recursive: true });
    await writeFile(
      join(localDir, 'agents', 'worker', 'SOUL.md'),
      'You are a LOCAL worker.',
    );
    await writeFile(
      join(localDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'daily-ops',
        version: '1.0.0',
        description: 'Local daily ops',
        namespace: 'ops',
        agents: {
          worker: {
            source: 'agents/worker',
            description: 'Does work',
          },
        },
      }),
    );

    await install(localDir, { yes: true });

    // Update with the same path 'daily-ops' — but local dir exists,
    // so registry should NOT be consulted
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    // Modify local source
    await writeFile(
      join(localDir, 'agents', 'worker', 'SOUL.md'),
      'You are an UPDATED LOCAL worker.',
    );

    await update(localDir, { yes: true });

    // Fetch should not have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Verify updated content
    const content = await readFile(
      join(tempHome, 'workspace-ops-worker', 'SOUL.md'),
      'utf-8',
    );
    expect(content).toContain('UPDATED LOCAL');
  });

  it('no-op local update after registry install clears registryRef', async () => {
    // Install from registry
    const v1 = await createFormationTarball('daily-ops', '1.0.0', 'ops');

    const registryUrl = 'https://registry.example.com';
    mockTideFetch(registryUrl, {
      'daily-ops': {
        latest: '1.0.0',
        versions: {
          '1.0.0': { sha256: v1.sha256 },
        },
      },
    }, { [v1.tarballPath]: v1.tarballPath });

    await install('daily-ops', { yes: true, registryUrl });

    let state = await loadState('ops', 'daily-ops');
    expect(state?.registryRef).toEqual({ name: 'daily-ops', version: '1.0.0' });

    // Create an identical local directory (same content → plan.isEmpty)
    const localDir = join(tempHome, 'local-daily-ops-noop');
    await mkdir(join(localDir, 'agents', 'worker'), { recursive: true });
    await writeFile(
      join(localDir, 'agents', 'worker', 'SOUL.md'),
      'You are a worker v1.0.0.',
    );
    await writeFile(
      join(localDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'daily-ops',
        version: '1.0.0',
        description: 'daily-ops formation',
        namespace: 'ops',
        agents: {
          worker: {
            source: 'agents/worker',
            description: 'Does work',
          },
        },
      }),
    );

    // Restore original fetch — no registry needed
    globalThis.fetch = originalFetch;

    // No-op local update (same version, same content)
    await update(localDir, { yes: true });

    // registryRef should be cleared even though plan was empty
    state = await loadState('ops', 'daily-ops');
    expect(state?.registryRef).toBeUndefined();
  });
});
