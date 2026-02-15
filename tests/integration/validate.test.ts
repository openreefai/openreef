import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validate } from '../../src/commands/validate.js';
import { computeFileHash } from '../../src/core/state-manager.js';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('node', [CLI, ...args]);
    return { ...result, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('reef validate', () => {
  it('validates the bundled template successfully', async () => {
    const result = await runCli('validate', TEMPLATE);
    expect(result.code).toBe(0);
  });

  it('outputs JSON with --json flag', async () => {
    const result = await runCli('validate', TEMPLATE, '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toBeInstanceOf(Array);
  });

  it('fails on a directory without reef.json', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      const result = await runCli('validate', tempDir);
      expect(result.code).not.toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails on invalid manifest JSON', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      await writeFile(join(tempDir, 'reef.json'), '{bad json}');
      const result = await runCli('validate', tempDir);
      expect(result.code).not.toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports structural errors for missing agent directories', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      // Write a valid schema manifest but with no agent directories
      const manifest = {
        reef: '1.0',
        type: 'solo',
        name: 'test',
        version: '0.1.0',
        description: 'Test formation',
        namespace: 'test',
        agents: {
          worker: { source: 'agents/worker', description: 'Worker agent' },
        },
      };
      await writeFile(join(tempDir, 'reef.json'), JSON.stringify(manifest));
      const result = await runCli('validate', tempDir, '--json');
      expect(result.code).not.toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.valid).toBe(false);
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ code: 'AGENT_DIR_MISSING' }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports structural errors for missing SOUL.md', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
    try {
      const manifest = {
        reef: '1.0',
        type: 'solo',
        name: 'test',
        version: '0.1.0',
        description: 'Test formation',
        namespace: 'test',
        agents: {
          worker: { source: 'agents/worker', description: 'Worker agent' },
        },
      };
      await writeFile(join(tempDir, 'reef.json'), JSON.stringify(manifest));
      await mkdir(join(tempDir, 'agents', 'worker'), { recursive: true });
      // No SOUL.md
      const result = await runCli('validate', tempDir, '--json');
      expect(result.code).not.toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ code: 'SOUL_MD_MISSING' }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── validate --deployed ─────────────────────────────────────────
describe('reef validate --deployed', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'reef-validate-deployed-'));
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
  });

  afterEach(async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  async function setupHealthyFormation(): Promise<void> {
    const workspaceDir = join(tempHome, 'ws-testns-triage');
    await mkdir(workspaceDir, { recursive: true });
    const soulContent = Buffer.from('# Triage Agent');
    await writeFile(join(workspaceDir, 'SOUL.md'), soulContent);

    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: {
          list: [{ id: 'testns-triage', name: 'triage', workspace: workspaceDir }],
        },
        bindings: [
          { agentId: 'testns-triage', match: { channel: 'slack:#support' } },
        ],
      }),
    );

    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });
    await writeFile(
      join(reefDir, 'testns--myapp.state.json'),
      JSON.stringify({
        name: 'myapp',
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
        bindings: [
          { agentId: 'testns-triage', match: { channel: 'slack:#support' } },
        ],
        cronJobs: [],
        variables: {},
        fileHashes: {
          'testns-triage:SOUL.md': computeFileHash(soulContent),
        },
      }),
    );
  }

  it('validates healthy deployed formation', async () => {
    await setupHealthyFormation();
    const result = await validate('testns/myapp', { deployed: true, quiet: true });
    expect(result.valid).toBe(true);
  });

  it('detects missing agent workspace', async () => {
    await setupHealthyFormation();
    // Delete the workspace
    await rm(join(tempHome, 'ws-testns-triage'), { recursive: true });

    const result = await validate('testns/myapp', { deployed: true, quiet: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'WORKSPACE_MISSING' }),
    );
  });

  it('detects file hash drift', async () => {
    await setupHealthyFormation();
    // Modify the file to cause drift
    await writeFile(
      join(tempHome, 'ws-testns-triage', 'SOUL.md'),
      '# Modified Triage Agent',
    );

    const result = await validate('testns/myapp', { deployed: true, quiet: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'FILE_HASH_DRIFT' }),
    );
  });

  it('detects binding referencing non-existent agent', async () => {
    const workspaceDir = join(tempHome, 'ws-testns-triage');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, 'SOUL.md'), '# Agent');

    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [{ id: 'testns-triage' }] },
        bindings: [
          { agentId: 'testns-triage', match: { channel: 'slack:#support' } },
        ],
      }),
    );

    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });
    await writeFile(
      join(reefDir, 'testns--myapp.state.json'),
      JSON.stringify({
        name: 'myapp',
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
        bindings: [
          // Binding references a non-existent agent
          { agentId: 'testns-ghost', match: { channel: 'slack:#general' } },
        ],
        cronJobs: [],
        variables: {},
        fileHashes: {},
      }),
    );

    const result = await validate('testns/myapp', { deployed: true, quiet: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'BINDING_INVALID_AGENT' }),
    );
  });

  it('detects agent missing from config.agents.list', async () => {
    const workspaceDir = join(tempHome, 'ws-testns-triage');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, 'SOUL.md'), '# Agent');

    // Config has NO agents
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [] },
        bindings: [],
      }),
    );

    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });
    await writeFile(
      join(reefDir, 'testns--myapp.state.json'),
      JSON.stringify({
        name: 'myapp',
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

    const result = await validate('testns/myapp', { deployed: true, quiet: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'AGENT_NOT_IN_CONFIG' }),
    );
  });

  it('detects binding missing from config.bindings', async () => {
    const workspaceDir = join(tempHome, 'ws-testns-triage');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, 'SOUL.md'), '# Agent');

    // Config has the agent but NOT the binding
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({
        agents: { list: [{ id: 'testns-triage' }] },
        bindings: [],
      }),
    );

    const reefDir = join(tempHome, '.reef');
    await mkdir(reefDir, { recursive: true });
    await writeFile(
      join(reefDir, 'testns--myapp.state.json'),
      JSON.stringify({
        name: 'myapp',
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
        bindings: [
          { agentId: 'testns-triage', match: { channel: 'slack:#support' } },
        ],
        cronJobs: [],
        variables: {},
        fileHashes: {},
      }),
    );

    const result = await validate('testns/myapp', { deployed: true, quiet: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'BINDING_NOT_IN_CONFIG' }),
    );
  });

  it('errors when identifier not found', async () => {
    await mkdir(join(tempHome, '.reef'), { recursive: true });
    await writeFile(
      join(tempHome, 'openclaw.json'),
      JSON.stringify({ agents: { list: [] }, bindings: [] }),
    );

    const result = await validate('testns/nonexistent', { deployed: true, quiet: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'FORMATION_NOT_FOUND' }),
    );
  });
});
