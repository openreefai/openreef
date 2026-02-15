import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { status } from '../../src/commands/status.js';

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-test-'));
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef status', () => {
  it('shows formation status with agents', async () => {
    // Create workspace directory so status sees it as existing
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    await mkdir(workspaceDir, { recursive: true });

    // Write config with agent entry
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: {
          list: [
            {
              id: 'testns-triage',
              name: 'triage',
              workspace: workspaceDir,
              model: 'anthropic/claude-sonnet-4-5',
            },
          ],
        },
        bindings: [],
      }),
    );

    // Write state file
    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });
    await writeFile(
      join(reefDir, 'testns--test-formation.state.json'),
      JSON.stringify({
        name: 'test-formation',
        version: '1.0.0',
        namespace: 'testns',
        installedAt: '2025-01-01T00:00:00.000Z',
        agents: {
          triage: {
            id: 'testns-triage',
            slug: 'triage',
            workspace: workspaceDir,
            files: ['SOUL.md'],
          },
        },
        bindings: [],
        cronJobs: [],
        variables: {},
        fileHashes: {},
      }),
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      await status('testns/test-formation', {});
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    expect(output).toContain('test-formation');
    expect(output).toContain('testns');
    expect(output).toContain('triage');
    expect(output).toContain('testns-triage');
  });

  it('outputs JSON when --json flag is set', async () => {
    // Create workspace directory
    const workspaceDir = join(tempHome, 'workspace-testns-triage');
    await mkdir(workspaceDir, { recursive: true });

    // Write config with agent entry
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: {
          list: [
            {
              id: 'testns-triage',
              name: 'triage',
              workspace: workspaceDir,
              model: 'anthropic/claude-sonnet-4-5',
            },
          ],
        },
        bindings: [],
      }),
    );

    // Write state file
    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });
    await writeFile(
      join(reefDir, 'testns--test-formation.state.json'),
      JSON.stringify({
        name: 'test-formation',
        version: '1.0.0',
        namespace: 'testns',
        installedAt: '2025-01-01T00:00:00.000Z',
        agents: {
          triage: {
            id: 'testns-triage',
            slug: 'triage',
            workspace: workspaceDir,
            files: ['SOUL.md'],
          },
        },
        bindings: [],
        cronJobs: [],
        variables: {},
        fileHashes: {},
      }),
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      await status('testns/test-formation', { json: true });
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.namespace).toBe('testns');
    expect(parsed.name).toBe('test-formation');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].slug).toBe('triage');
    expect(parsed.agents[0].id).toBe('testns-triage');
    expect(parsed.agents[0].inConfig).toBe(true);
    expect(parsed.agents[0].workspaceExists).toBe(true);
  });

  it('errors when formation not found', async () => {
    // Write a minimal config (no agents)
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({ agents: { list: [] }, bindings: [] }),
    );

    // Ensure .reef dir exists but is empty
    await mkdir(join(tempHome, '.reef'), { recursive: true });

    // Mock process.exit to capture the call
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) =>
      errors.push(args.map(String).join(' '));

    try {
      await status('testns/nonexistent', {});
      expect.unreachable('Expected process.exit to be called');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      console.error = originalError;
    }

    expect(mockExit).toHaveBeenCalledWith(1);

    const errorOutput = errors.join('\n');
    expect(errorOutput).toContain('not found');

    mockExit.mockRestore();
  });
});
