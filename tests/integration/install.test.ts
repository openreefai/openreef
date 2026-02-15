import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install } from '../../src/commands/install.js';
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
    // {{namespace}} is not declared as a variable, so it stays as-is per the interpolator
    expect(soulContent).toContain('{{namespace}}');

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
            channel: 'discord:general',
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
      'discord:general',
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

    // Formation declares both telegram and slack bindings
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
          { channel: 'telegram', agent: 'triage' },
          { channel: 'slack:#support', agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true });

    // Only telegram binding should be in config
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

    // State should also have only the telegram binding
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

  it('--yes wires all when no channels section (backward compat)', async () => {
    // Minimal config WITHOUT channels section
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [] },
        bindings: [],
      }),
    );

    // Formation with discord and slack bindings
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
          { channel: 'discord:general', agent: 'triage' },
          { channel: 'slack', agent: 'triage' },
        ],
      }),
    );

    await install(formationDir, { yes: true });

    // Both bindings should be wired
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
    expect(channels).toContain('discord:general');
    expect(channels).toContain('slack');
  });

  it('--merge ignores channel availability', async () => {
    // First install with both bindings (no channels section, all wired)
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
          { channel: 'slack', agent: 'triage' },
          { channel: 'telegram', agent: 'triage' },
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
});
