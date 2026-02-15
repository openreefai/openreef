import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { list } from '../../src/commands/list.js';

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-test-'));
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');

  // Write minimal valid config
  await writeFile(
    join(tempHome, 'openclaw.json'),
    JSON.stringify({ agents: { list: [] }, bindings: [] }),
  );
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef list', () => {
  it('shows message when no formations installed', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      await list({});
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    expect(output).toContain('No formations installed');
  });

  it('lists installed formations', async () => {
    // Create .reef state directory and write 2 state files
    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });

    await writeFile(
      join(reefDir, 'testns--formation-a.state.json'),
      JSON.stringify({
        name: 'formation-a',
        version: '1.0.0',
        namespace: 'testns',
        installedAt: '2025-01-01T00:00:00.000Z',
        agents: {
          agent1: {
            id: 'testns-agent1',
            slug: 'agent1',
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
      join(reefDir, 'otherns--formation-b.state.json'),
      JSON.stringify({
        name: 'formation-b',
        version: '2.0.0',
        namespace: 'otherns',
        installedAt: '2025-06-15T12:00:00.000Z',
        agents: {
          worker: {
            id: 'otherns-worker',
            slug: 'worker',
            workspace: '/tmp/ws2',
            files: ['SOUL.md'],
          },
          manager: {
            id: 'otherns-manager',
            slug: 'manager',
            workspace: '/tmp/ws3',
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
      await list({});
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    expect(output).toContain('formation-a');
    expect(output).toContain('formation-b');
    expect(output).toContain('testns');
    expect(output).toContain('otherns');
  });

  it('outputs JSON when --json flag is set', async () => {
    // Create .reef state directory and write state files
    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });

    await writeFile(
      join(reefDir, 'testns--formation-a.state.json'),
      JSON.stringify({
        name: 'formation-a',
        version: '1.0.0',
        namespace: 'testns',
        installedAt: '2025-01-01T00:00:00.000Z',
        agents: {
          agent1: {
            id: 'testns-agent1',
            slug: 'agent1',
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
      join(reefDir, 'otherns--formation-b.state.json'),
      JSON.stringify({
        name: 'formation-b',
        version: '2.0.0',
        namespace: 'otherns',
        installedAt: '2025-06-15T12:00:00.000Z',
        agents: {
          worker: {
            id: 'otherns-worker',
            slug: 'worker',
            workspace: '/tmp/ws2',
            files: ['SOUL.md'],
          },
        },
        bindings: [
          { agentId: 'otherns-worker', match: { channel: 'slack:general' } },
        ],
        cronJobs: [
          { id: 'job-1', name: 'reef:otherns:worker-0', agentSlug: 'worker' },
        ],
        variables: {},
        fileHashes: {},
      }),
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      await list({ json: true });
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    const formA = parsed.find(
      (f: Record<string, unknown>) => f.name === 'formation-a',
    );
    expect(formA).toBeDefined();
    expect(formA.namespace).toBe('testns');
    expect(formA.version).toBe('1.0.0');
    expect(formA.agents).toBe(1);

    const formB = parsed.find(
      (f: Record<string, unknown>) => f.name === 'formation-b',
    );
    expect(formB).toBeDefined();
    expect(formB.namespace).toBe('otherns');
    expect(formB.version).toBe('2.0.0');
    expect(formB.agents).toBe(1);
    expect(formB.bindings).toBe(1);
    expect(formB.cronJobs).toBe(1);
  });
});
