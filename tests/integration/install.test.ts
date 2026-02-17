import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create as createTar } from 'tar';
import { install } from '../../src/commands/install.js';
import { registryCacheDir } from '../../src/core/registry.js';
import { createMockGateway, type MockGateway } from '../helpers/mock-gateway.js';

let tempHome: string;
let formationDir: string;
let mockGw: MockGateway | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-test-'));
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');

  // Write minimal valid config
  await writeFile(
    join(tempHome, 'openclaw.json'),
    JSON.stringify({ agents: { list: [] }, bindings: [] }),
  );

  // Create formation directory with reef.json and agent files
  formationDir = join(tempHome, 'my-formation');
  await mkdir(formationDir, { recursive: true });
  await mkdir(join(formationDir, 'agents', 'triage'), { recursive: true });
  await writeFile(
    join(formationDir, 'agents', 'triage', 'SOUL.md'),
    'You are {{MISSION}} agent for {{namespace}}.',
  );

  // Write a reef.json manifest
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
        MISSION: {
          type: 'string',
          default: 'support',
        },
      },
      agents: {
        triage: {
          source: 'agents/triage',
          description: 'Handles triage',
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    }),
  );

  // Setup mock Gateway WebSocket server (may be null in sandboxed environments)
  mockGw = await createMockGateway();
});

afterEach(async () => {
  if (mockGw) {
    mockGw.wss.close();
    mockGw = null;
  }
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef install', () => {
  it('basic install deploys agent, workspace, and state', async () => {
    await install(formationDir, { yes: true });

    // Config file should have agent entry with id testns-triage
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const agentsList = config.agents.list as Record<string, unknown>[];

    // Main should be seeded as first entry
    expect(agentsList[0].id).toBe('main');

    const triageAgent = agentsList.find((a) => a.id === 'testns-triage');
    expect(triageAgent).toBeDefined();
    expect(triageAgent!.model).toBe('anthropic/claude-sonnet-4-5');

    // Workspace dir should exist
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    expect(existsSync(workspaceDir)).toBe(true);

    // SOUL.md should have variables interpolated
    const soulContent = await readFile(
      join(workspaceDir, 'SOUL.md'),
      'utf-8',
    );
    expect(soulContent).toContain('support');
    expect(soulContent).not.toContain('{{MISSION}}');
    // {{namespace}} is a built-in variable, should be interpolated
    expect(soulContent).toContain('testns');
    expect(soulContent).not.toContain('{{namespace}}');

    // State file should exist
    const stateDir = join(tempHome, '.reef');
    const stateFile = join(stateDir, 'testns--test-formation.state.json');
    expect(existsSync(stateFile)).toBe(true);

    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.name).toBe('test-formation');
    expect(state.namespace).toBe('testns');
    expect(state.version).toBe('1.0.0');
    expect(state.agents.triage).toBeDefined();
    expect(state.agents.triage.id).toBe('testns-triage');
  });

  it('install with cron creates cron jobs in state', async () => {
    if (!mockGw) return; // Skip in sandboxed environments

    // Write manifest with cron entry
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with cron',
        namespace: 'testns',
        variables: {
          MISSION: {
            type: 'string',
            default: 'support',
          },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        cron: [
          {
            schedule: '0 9 * * 1-5',
            agent: 'triage',
            prompt: 'Daily check',
          },
        ],
      }),
    );

    await install(formationDir, {
      yes: true,
      gatewayUrl: `ws://127.0.0.1:${mockGw.port}`,
      gatewayToken: 'test-token',
    });

    // Verify cron in state file
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.cronJobs).toHaveLength(1);
    expect(state.cronJobs[0].name).toBe('reef:testns:triage-0');
    expect(state.cronJobs[0].agentSlug).toBe('triage');
    expect(state.cronJobs[0].id).toMatch(/^job-/);
  });

  it('install with bindings wires bindings into config', async () => {
    // Write manifest with bindings
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with bindings',
        namespace: 'testns',
        variables: {
          MISSION: {
            type: 'string',
            default: 'support',
          },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          {
            match: { channel: 'discord', peer: { kind: 'channel', id: 'general' } },
            agent: 'triage',
          },
        ],
      }),
    );

    await install(formationDir, { yes: true });

    // Verify bindings in config
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect(bindings[0].agentId).toBe('testns-triage');
    expect((bindings[0].match as Record<string, unknown>).channel).toBe(
      'discord',
    );

    // Verify bindings in state file
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].agentId).toBe('testns-triage');
  });

  it('install with agentToAgent enables tools and generates AGENTS.md', async () => {
    // Create a second agent directory
    await mkdir(join(formationDir, 'agents', 'researcher'), {
      recursive: true,
    });
    await writeFile(
      join(formationDir, 'agents', 'researcher', 'SOUL.md'),
      'You are a researcher.',
    );

    // Write manifest with agentToAgent
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'shoal',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with a2a',
        namespace: 'testns',
        variables: {
          MISSION: {
            type: 'string',
            default: 'support',
          },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
          researcher: {
            source: 'agents/researcher',
            description: 'Does research',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        agentToAgent: {
          triage: ['researcher'],
        },
      }),
    );

    await install(formationDir, { yes: true });

    // Verify tools.agentToAgent in config
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.tools).toBeDefined();
    expect(config.tools.agentToAgent).toBeDefined();
    expect(config.tools.agentToAgent.enabled).toBe(true);
    expect(config.tools.agentToAgent.allow).toContain('testns-*');

    // Verify AGENTS.md was generated for triage (the agent that has a2a edges)
    const agentsMdPath = join(
      tempHome,
      'workspace-testns-triage',
      'AGENTS.md',
    );
    expect(existsSync(agentsMdPath)).toBe(true);
    const agentsMd = await readFile(agentsMdPath, 'utf-8');
    expect(agentsMd).toContain('researcher');
    expect(agentsMd).toContain('testns-researcher');

    // Researcher should NOT have AGENTS.md since it has no a2a edges
    const researcherAgentsMd = join(
      tempHome,
      'workspace-testns-researcher',
      'AGENTS.md',
    );
    expect(existsSync(researcherAgentsMd)).toBe(false);
  });

  it('--yes skips bindings for unconfigured channels', async () => {
    // Config has only telegram configured
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [] },
        bindings: [],
        channels: {
          telegram: { enabled: true, botToken: '123:ABC' },
        },
      }),
    );

    // Formation declares both scoped telegram and unconfigured slack bindings
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with multi-channel bindings',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
        },
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

    await install(formationDir, { yes: true });

    // Only scoped telegram binding should be in config (slack is unconfigured)
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0].match as Record<string, unknown>).channel).toBe(
      'telegram',
    );

    // State should also have only the scoped telegram binding
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].match.channel).toBe('telegram');
  });

  it('--yes wires all scoped bindings when no channels section (backward compat)', async () => {
    // Minimal config WITHOUT channels section
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [] },
        bindings: [],
      }),
    );

    // Formation with scoped discord and slack bindings
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with bindings',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { match: { channel: 'discord', peer: { kind: 'channel', id: 'general' } }, agent: 'triage' },
          { match: { channel: 'slack', peer: { kind: 'channel', id: '#support' } }, agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true });

    // Both scoped bindings should be wired
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(2);

    const channels = bindings.map(
      (b) => (b.match as Record<string, unknown>).channel,
    );
    expect(channels).toContain('discord');
    expect(channels).toContain('slack');
  });

  it('--merge ignores channel availability', async () => {
    // First install with scoped bindings (no channels section, all wired)
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with bindings',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { match: { channel: 'slack', peer: { kind: 'channel', id: '#support' } }, agent: 'triage' },
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true });

    // Verify initial install wired both
    let configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    let config = JSON.parse(configRaw);
    expect(config.bindings).toHaveLength(2);

    // Now add channels section with only telegram configured
    config.channels = { telegram: { enabled: true } };
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify(config),
    );

    // Run install --merge --yes
    await install(formationDir, { yes: true, merge: true });

    // Both bindings should still be present (merge wires all)
    configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(2);

    const channels = bindings.map(
      (b) => (b.match as Record<string, unknown>).channel,
    );
    expect(channels).toContain('slack');
    expect(channels).toContain('telegram');

    // State should also have both
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.bindings).toHaveLength(2);
  });

  it('install preserves main in agents.list', async () => {
    await install(formationDir, { yes: true });

    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const agentsList = config.agents.list as Record<string, unknown>[];
    expect(agentsList[0].id).toBe('main');
    expect(agentsList.length).toBeGreaterThanOrEqual(2);
  });

  it('--yes wires channel-only bindings (match objects are not bare)', async () => {
    // Config with telegram configured
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [] },
        bindings: [],
        channels: {
          telegram: { enabled: true, botToken: '123:ABC' },
        },
      }),
    );

    // Formation with channel-only and peer-targeted telegram bindings
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with channel-only binding',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { match: { channel: 'telegram' }, agent: 'triage' },
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true });

    // Both bindings should be wired — channel-only is intentional with match objects
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(2);
  });

  it('--yes --allow-channel-shadow wires bare channel bindings', async () => {
    // Config with telegram configured
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [] },
        bindings: [],
        channels: {
          telegram: { enabled: true, botToken: '123:ABC' },
        },
      }),
    );

    // Formation with bare telegram binding
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with bare binding',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { match: { channel: 'telegram' }, agent: 'triage' },
          { match: { channel: 'telegram', peer: { kind: 'group', id: 'group-123' } }, agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true, allowChannelShadow: true });

    // Both bindings should be wired
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(2);
    // Verify both bare and scoped bindings were wired
    const hasBare = bindings.some((b) => !(b.match as Record<string, unknown>).peer);
    const hasScoped = bindings.some((b) => !!(b.match as Record<string, unknown>).peer);
    expect(hasBare).toBe(true);
    expect(hasScoped).toBe(true);
  });

  it('install resolves {{VARIABLE}} in binding channels', async () => {
    // Write manifest with variable-templated binding and declared variable
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with binding variable',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
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
        bindings: [
          { match: { channel: '{{INTERACTION_CHANNEL}}', peer: { kind: '{{INTERACTION_PEER_KIND}}', id: '{{INTERACTION_PEER_ID}}' } }, agent: 'triage' },
        ],
      }),
    );

    // Provide variable via .env file
    await writeFile(
      join(formationDir, '.env'),
      'INTERACTION_CHANNEL=slack\nINTERACTION_PEER_KIND=channel\nINTERACTION_PEER_ID="#ops"',
    );

    await install(formationDir, { yes: true });

    // Verify the binding was wired with the resolved value, not the token
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0].match as Record<string, unknown>).channel).toBe(
      'slack',
    );

    // State should also have the resolved binding
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].match.channel).toBe('slack');
  });

  it('install drops binding with unresolved {{VARIABLE}}', async () => {
    // Write manifest with variable-templated binding but do NOT provide the variable
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'test-formation',
        version: '1.0.0',
        description: 'Test formation with unresolved binding variable',
        namespace: 'testns',
        variables: {
          MISSION: { type: 'string', default: 'support' },
          INTERACTION_CHANNEL: { type: 'string' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { match: { channel: '{{INTERACTION_CHANNEL}}' }, agent: 'triage' },
        ],
      }),
    );

    // No .env file, no --set, no env var for INTERACTION_CHANNEL
    await install(formationDir, { yes: true });

    // Verify the binding was dropped (not wired with literal token)
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(0);

    // State should have no bindings either
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.bindings).toHaveLength(0);
  });

  it('--merge does not filter bare channel bindings', async () => {
    // First install
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
          MISSION: { type: 'string', default: 'support' },
        },
        agents: {
          triage: {
            source: 'agents/triage',
            description: 'Handles triage',
            model: 'anthropic/claude-sonnet-4-5',
          },
        },
        bindings: [
          { match: { channel: 'telegram' }, agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true, allowChannelShadow: true });

    // Now merge — should wire bare binding
    await install(formationDir, { yes: true, merge: true });

    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const bindings = config.bindings as Record<string, unknown>[];
    expect(bindings).toHaveLength(1);
    expect((bindings[0].match as Record<string, unknown>).channel).toBe('telegram');
  });

  it('--merge skips unchanged files and updates state', async () => {
    // First install
    await install(formationDir, { yes: true });

    // Read initial state
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    const initialStateRaw = await readFile(stateFile, 'utf-8');
    const initialState = JSON.parse(initialStateRaw);
    const initialInstalledAt = initialState.installedAt;

    // Wait a tiny bit so timestamp differs
    await new Promise((r) => setTimeout(r, 50));

    // Reinstall with --merge
    await install(formationDir, { yes: true, merge: true });

    // Read updated state
    const updatedStateRaw = await readFile(stateFile, 'utf-8');
    const updatedState = JSON.parse(updatedStateRaw);

    // State should be updated with new timestamp
    expect(updatedState.installedAt).not.toBe(initialInstalledAt);

    // Agent should still be intact
    expect(updatedState.agents.triage).toBeDefined();
    expect(updatedState.agents.triage.id).toBe('testns-triage');

    // File hashes should still be present (files were skipped but hashes preserved)
    expect(Object.keys(updatedState.fileHashes).length).toBeGreaterThan(0);

    // Workspace should still exist
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('interpolates {{tools}} built-in variable per agent', async () => {
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

    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    const soulContent = await readFile(
      join(workspaceDir, 'SOUL.md'),
      'utf-8',
    );

    expect(soulContent).toContain('- **web-search** (^1.2.0)');
    expect(soulContent).toContain('- **calculator**');
    expect(soulContent).not.toContain('{{tools}}');
  });
});

// ── Registry integration tests ──

describe('reef install (registry)', () => {
  let tempHome: string;
  let registryFormationDir: string;
  let tarballPath: string;
  let tarballSha256: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-reg-install-'));
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
    originalFetch = globalThis.fetch;

    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({ agents: { list: [] }, bindings: [] }),
    );

    // Create a formation directory and pack it into a tarball
    registryFormationDir = join(tempHome, 'reg-formation');
    await mkdir(join(registryFormationDir, 'agents', 'worker'), {
      recursive: true,
    });
    await writeFile(
      join(registryFormationDir, 'agents', 'worker', 'SOUL.md'),
      'You are a registry worker.',
    );
    await writeFile(
      join(registryFormationDir, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'daily-ops',
        version: '1.2.0',
        description: 'Daily operations',
        namespace: 'ops',
        agents: {
          worker: {
            source: 'agents/worker',
            description: 'Does work',
          },
        },
      }),
    );

    // Create tarball
    tarballPath = join(tempHome, 'daily-ops-1.2.0.reef.tar.gz');
    await createTar(
      { gzip: true, file: tarballPath, cwd: registryFormationDir },
      ['.'],
    );

    // Compute sha256
    const tarballContent = await readFile(tarballPath);
    tarballSha256 = createHash('sha256').update(tarballContent).digest('hex');
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  function mockRegistryFetch(registryUrl: string) {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      // Tide API: GET /api/formations/daily-ops (formation detail)
      if (url.includes('/api/formations/daily-ops') && !url.includes('/1.2.0') && !url.includes('/resolve')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            name: 'daily-ops',
            description: 'Daily operations',
            latest_version: '1.2.0',
          }),
        };
      }
      // Tide API: GET /api/formations/daily-ops/1.2.0 (version detail)
      if (url.includes('/api/formations/daily-ops/1.2.0') && !url.includes('/download')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            name: 'daily-ops',
            version: '1.2.0',
            sha256: tarballSha256,
          }),
        };
      }
      // Tide API: GET /api/formations/daily-ops/1.2.0/download (tarball download)
      if (url.includes('/api/formations/daily-ops/1.2.0/download')) {
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
    }) as unknown as typeof fetch;
  }

  it('installs by bare name from registry', async () => {
    mockRegistryFetch('https://registry.example.com/index.json');

    await install('daily-ops', {
      yes: true,
      registryUrl: 'https://registry.example.com/index.json',
    });

    // Verify agent was deployed
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const agentsList = config.agents.list as Record<string, unknown>[];
    const workerAgent = agentsList.find((a) => a.id === 'ops-worker');
    expect(workerAgent).toBeDefined();

    // Verify workspace exists
    const workspaceDir = join(tempHome, 'workspace-ops-worker');
    expect(existsSync(workspaceDir)).toBe(true);

    // Verify state
    const stateFile = join(
      tempHome,
      '.reef',
      'ops--daily-ops.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.name).toBe('daily-ops');
    expect(state.registryRef).toEqual({ name: 'daily-ops', version: '1.2.0' });
  });

  it('installs with @version syntax', async () => {
    mockRegistryFetch('https://registry.example.com/index.json');

    await install('daily-ops@1.2.0', {
      yes: true,
      registryUrl: 'https://registry.example.com/index.json',
    });

    const stateFile = join(
      tempHome,
      '.reef',
      'ops--daily-ops.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.registryRef).toEqual({ name: 'daily-ops', version: '1.2.0' });
  });

  it('throws error for unknown formation name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Formation not found' }),
    }) as unknown as typeof fetch;

    await expect(
      install('nonexistent', {
        yes: true,
        registryUrl: 'https://registry.example.com',
      }),
    ).rejects.toThrow(/not found in registry/);
  });

  it('local directory takes precedence over registry', async () => {
    // Create a local ./daily-ops directory with reef.json
    const localDir = join(tempHome, 'local-project');
    await mkdir(localDir, { recursive: true });
    const localFormation = join(localDir, 'daily-ops');
    await mkdir(join(localFormation, 'agents', 'local-worker'), {
      recursive: true,
    });
    await writeFile(
      join(localFormation, 'agents', 'local-worker', 'SOUL.md'),
      'You are a LOCAL worker.',
    );
    await writeFile(
      join(localFormation, 'reef.json'),
      JSON.stringify({
        reef: '1.0',
        type: 'solo',
        name: 'daily-ops',
        version: '0.0.1',
        description: 'Local daily ops',
        namespace: 'local',
        agents: {
          'local-worker': {
            source: 'agents/local-worker',
            description: 'Local agent',
          },
        },
      }),
    );

    // Mock fetch — should NOT be called since local takes precedence
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await install(localFormation, {
      yes: true,
      registryUrl: 'https://registry.example.com/index.json',
    });

    // Fetch should not have been called (local path existed)
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Verify local formation was used
    const stateFile = join(
      tempHome,
      '.reef',
      'local--daily-ops.state.json',
    );
    const stateRaw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.version).toBe('0.0.1');
    expect(state.registryRef).toBeUndefined();
  });

  it('cache separation — different registry URLs get separate caches', async () => {
    const env = { OPENCLAW_STATE_DIR: tempHome } as NodeJS.ProcessEnv;
    const dir1 = registryCacheDir('https://registry1.example.com/index.json', env);
    const dir2 = registryCacheDir('https://registry2.example.com/index.json', env);
    expect(dir1).not.toBe(dir2);

    // Both should be under .reef/cache/ but with different hashes
    expect(dir1).toContain(join('.reef', 'cache'));
    expect(dir2).toContain(join('.reef', 'cache'));
  });
});
