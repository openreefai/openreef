import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { install } from '../../src/commands/install.js';
import { uninstall } from '../../src/commands/uninstall.js';
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
    'You are a triage agent.',
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

describe('reef uninstall', () => {
  it('basic uninstall removes agent, workspace, bindings, and state', async () => {
    // Add bindings to the manifest for a more thorough test
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
        bindings: [
          {
            channel: 'discord:general',
            agent: 'triage',
          },
        ],
      }),
    );

    // First install
    await install(formationDir, { yes: true });

    // Verify install worked
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    expect(existsSync(workspaceDir)).toBe(true);
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    expect(existsSync(stateFile)).toBe(true);

    // Now uninstall
    await uninstall('testns/test-formation', { yes: true });

    // Config should have only the seeded "main" agent remaining
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.agents.list).toHaveLength(1);
    expect(config.agents.list[0].id).toBe('main');

    // Bindings should be removed
    expect(config.bindings).toHaveLength(0);

    // Workspace dir should be deleted
    expect(existsSync(workspaceDir)).toBe(false);

    // State file should be deleted
    expect(existsSync(stateFile)).toBe(false);
  });

  it('uninstall with bare name resolves to unique formation', async () => {
    // Install the formation
    await install(formationDir, { yes: true });

    // Verify install worked
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    expect(existsSync(workspaceDir)).toBe(true);

    // Uninstall using just the name (no namespace)
    await uninstall('test-formation', { yes: true });

    // Workspace should be deleted
    expect(existsSync(workspaceDir)).toBe(false);

    // State file should be deleted
    const stateFile = join(
      tempHome,
      '.reef',
      'testns--test-formation.state.json',
    );
    expect(existsSync(stateFile)).toBe(false);

    // Config should have only the seeded "main" agent remaining
    const configRaw = await readFile(
      join(tempHome, 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.agents.list).toHaveLength(1);
    expect(config.agents.list[0].id).toBe('main');
  });

  it('uninstall with ambiguous bare name fails', async () => {
    // Create 2 state files with same name but different namespaces
    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });

    await writeFile(
      join(reefDir, 'ns1--test-formation.state.json'),
      JSON.stringify({
        name: 'test-formation',
        version: '1.0.0',
        namespace: 'ns1',
        installedAt: '2025-01-01T00:00:00.000Z',
        agents: {
          triage: {
            id: 'ns1-triage',
            slug: 'triage',
            workspace: '/tmp/ws1',
            files: [],
          },
        },
        bindings: [],
        cronJobs: [],
        variables: {},
        fileHashes: {},
      }),
    );

    await writeFile(
      join(reefDir, 'ns2--test-formation.state.json'),
      JSON.stringify({
        name: 'test-formation',
        version: '1.0.0',
        namespace: 'ns2',
        installedAt: '2025-01-01T00:00:00.000Z',
        agents: {
          triage: {
            id: 'ns2-triage',
            slug: 'triage',
            workspace: '/tmp/ws2',
            files: [],
          },
        },
        bindings: [],
        cronJobs: [],
        variables: {},
        fileHashes: {},
      }),
    );

    // Mock process.exit to capture the call
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    try {
      await uninstall('test-formation', { yes: true });
      // Should not reach here
      expect.unreachable('Expected process.exit to be called');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});
