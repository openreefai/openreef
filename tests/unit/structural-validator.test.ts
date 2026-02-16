import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateStructure } from '../../src/core/structural-validator.js';
import type { ReefManifest } from '../../src/types/manifest.js';

let tempDir: string;

function baseManifest(overrides?: Partial<ReefManifest>): ReefManifest {
  return {
    reef: '1.0',
    type: 'shoal',
    name: 'test',
    version: '0.1.0',
    description: 'Test',
    namespace: 'test',
    agents: {
      alpha: { source: 'agents/alpha', description: 'Alpha agent' },
      beta: { source: 'agents/beta', description: 'Beta agent' },
    },
    ...overrides,
  };
}

async function createAgentDir(dir: string, slug: string, withSoul = true) {
  const agentDir = join(dir, 'agents', slug);
  await mkdir(agentDir, { recursive: true });
  if (withSoul) {
    await writeFile(join(agentDir, 'SOUL.md'), `# ${slug}\n`);
  }
}

describe('structural-validator', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('passes when all agent dirs and SOUL.md exist', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const result = await validateStructure(baseManifest(), tempDir);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('errors when agent source directory is missing', async () => {
    await createAgentDir(tempDir, 'alpha');
    // beta directory intentionally missing

    const result = await validateStructure(baseManifest(), tempDir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'AGENT_DIR_MISSING' }),
    );
  });

  it('errors when SOUL.md is missing', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta', false);

    const result = await validateStructure(baseManifest(), tempDir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SOUL_MD_MISSING' }),
    );
  });

  it('errors on invalid agentToAgent references', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const manifest = baseManifest({
      agentToAgent: { alpha: ['ghost'] },
    });
    const result = await validateStructure(manifest, tempDir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'AGENT_REF_INVALID' }),
    );
  });

  it('errors on invalid binding agent references', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const manifest = baseManifest({
      bindings: [{ channel: 'slack:#test', agent: 'ghost' }],
    });
    const result = await validateStructure(manifest, tempDir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'BINDING_REF_INVALID' }),
    );
  });

  it('errors on invalid cron agent references', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const manifest = baseManifest({
      cron: [{ schedule: '0 9 * * *', agent: 'ghost', prompt: 'test' }],
    });
    const result = await validateStructure(manifest, tempDir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'CRON_REF_INVALID' }),
    );
  });

  it('warns on type/agent-count mismatch for solo', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const manifest = baseManifest({ type: 'solo' });
    const result = await validateStructure(manifest, tempDir);
    expect(result.valid).toBe(true); // warnings don't affect validity
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'TYPE_COUNT_MISMATCH' }),
    );
  });

  it('warns on undeclared variable tokens', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');
    // Write a SOUL.md with an undeclared variable
    await writeFile(
      join(tempDir, 'agents', 'alpha', 'SOUL.md'),
      '# Alpha\nHello {{UNDECLARED_VAR}}',
    );

    const manifest = baseManifest({ variables: {} });
    const result = await validateStructure(manifest, tempDir);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'UNDECLARED_VARIABLE' }),
    );
  });

  it('warns when binding channel references undeclared variable', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const manifest = baseManifest({
      bindings: [{ channel: '{{UNDECLARED_VAR}}', agent: 'alpha' }],
      variables: {},
    });
    const result = await validateStructure(manifest, tempDir);
    expect(result.valid).toBe(true); // warnings don't affect validity
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'UNDECLARED_BINDING_VARIABLE' }),
    );
  });

  it('no warning when binding channel references declared variable', async () => {
    await createAgentDir(tempDir, 'alpha');
    await createAgentDir(tempDir, 'beta');

    const manifest = baseManifest({
      bindings: [{ channel: '{{INTERACTION_CHANNEL}}', agent: 'alpha' }],
      variables: {
        INTERACTION_CHANNEL: { type: 'string', description: 'Channel for interactions' },
      },
    });
    const result = await validateStructure(manifest, tempDir);
    expect(result.issues.filter((i) => i.code === 'UNDECLARED_BINDING_VARIABLE')).toHaveLength(0);
  });
});
