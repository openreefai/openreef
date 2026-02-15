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

  function mockFetch(
    registryUrl: string,
    index: object,
    tarballs: Record<string, string>,
  ) {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === registryUrl) {
        return {
          ok: true,
          json: () => Promise.resolve(index),
        };
      }
      if (tarballs[url]) {
        const content = await readFile(tarballs[url]);
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
      return { ok: false, status: 404, statusText: 'Not Found' };
    }) as unknown as typeof fetch;
  }

  it('update via registry resolves bare name', async () => {
    const v1 = await createFormationTarball('daily-ops', '1.0.0', 'ops');
    const v2 = await createFormationTarball('daily-ops', '1.1.0', 'ops');

    const registryUrl = 'https://registry.example.com/index.json';

    // First install v1.0.0
    const installIndex = {
      version: 1,
      formations: {
        'daily-ops': {
          latest: '1.0.0',
          versions: {
            '1.0.0': {
              url: 'https://example.com/daily-ops-1.0.0.tar.gz',
              sha256: v1.sha256,
            },
          },
        },
      },
    };

    mockFetch(registryUrl, installIndex, {
      'https://example.com/daily-ops-1.0.0.tar.gz': v1.tarballPath,
    });

    await install('daily-ops', {
      yes: true,
      registryUrl,
    });

    let state = await loadState('ops', 'daily-ops');
    expect(state?.version).toBe('1.0.0');
    expect(state?.registryRef).toEqual({ name: 'daily-ops', version: '1.0.0' });

    // Now update to v1.1.0
    const updateIndex = {
      version: 1,
      formations: {
        'daily-ops': {
          latest: '1.1.0',
          versions: {
            '1.0.0': {
              url: 'https://example.com/daily-ops-1.0.0.tar.gz',
              sha256: v1.sha256,
            },
            '1.1.0': {
              url: 'https://example.com/daily-ops-1.1.0.tar.gz',
              sha256: v2.sha256,
            },
          },
        },
      },
    };

    mockFetch(registryUrl, updateIndex, {
      'https://example.com/daily-ops-1.1.0.tar.gz': v2.tarballPath,
    });

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

    const registryUrl = 'https://registry.example.com/index.json';
    const index = {
      version: 1,
      formations: {
        'sketchy': {
          latest: '0.1.0',
          versions: {
            '0.1.0': {
              url: 'https://example.com/sketchy-0.1.0.tar.gz',
              // no sha256 — unverified
            },
          },
        },
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetch(registryUrl, index, {
      'https://example.com/sketchy-0.1.0.tar.gz': v1.tarballPath,
    });

    await install('sketchy', {
      yes: true,
      registryUrl,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNVERIFIED'),
    );

    // Update — should re-download since unverified
    mockFetch(registryUrl, index, {
      'https://example.com/sketchy-0.1.0.tar.gz': v1.tarballPath,
    });

    await update('sketchy', {
      yes: true,
      registryUrl,
      skipCache: true,
    });

    // The tarball download URL should have been fetched during update
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/sketchy-0.1.0.tar.gz',
      expect.anything(),
    );

    warnSpy.mockRestore();
  });

  it('update from local after registry install clears registryRef', async () => {
    const v1 = await createFormationTarball('daily-ops', '1.0.0', 'ops');

    const registryUrl = 'https://registry.example.com/index.json';
    const index = {
      version: 1,
      formations: {
        'daily-ops': {
          latest: '1.0.0',
          versions: {
            '1.0.0': {
              url: 'https://example.com/daily-ops-1.0.0.tar.gz',
              sha256: v1.sha256,
            },
          },
        },
      },
    };

    mockFetch(registryUrl, index, {
      'https://example.com/daily-ops-1.0.0.tar.gz': v1.tarballPath,
    });

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

    const registryUrl = 'https://registry.example.com/index.json';

    // Install v1
    mockFetch(
      registryUrl,
      {
        version: 1,
        formations: {
          'daily-ops': {
            latest: '1.0.0',
            versions: {
              '1.0.0': {
                url: 'https://example.com/daily-ops-1.0.0.tar.gz',
                sha256: v1.sha256,
              },
            },
          },
        },
      },
      { 'https://example.com/daily-ops-1.0.0.tar.gz': v1.tarballPath },
    );
    await install('daily-ops', { yes: true, registryUrl });

    let state = await loadState('ops', 'daily-ops');
    expect(state?.registryRef?.version).toBe('1.0.0');

    // Update to v2 via registry
    mockFetch(
      registryUrl,
      {
        version: 1,
        formations: {
          'daily-ops': {
            latest: '2.0.0',
            versions: {
              '1.0.0': {
                url: 'https://example.com/daily-ops-1.0.0.tar.gz',
                sha256: v1.sha256,
              },
              '2.0.0': {
                url: 'https://example.com/daily-ops-2.0.0.tar.gz',
                sha256: v2.sha256,
              },
            },
          },
        },
      },
      { 'https://example.com/daily-ops-2.0.0.tar.gz': v2.tarballPath },
    );
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

    const registryUrl = 'https://registry.example.com/index.json';
    mockFetch(
      registryUrl,
      {
        version: 1,
        formations: {
          'daily-ops': {
            latest: '1.0.0',
            versions: {
              '1.0.0': {
                url: 'https://example.com/daily-ops-1.0.0.tar.gz',
                sha256: v1.sha256,
              },
            },
          },
        },
      },
      { 'https://example.com/daily-ops-1.0.0.tar.gz': v1.tarballPath },
    );

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
