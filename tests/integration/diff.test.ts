import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeFormationDiff, DiffValidationError } from '../../src/core/diff-engine.js';
import type { FormationState } from '../../src/types/state.js';

let tempHome: string;
let formationDir: string;

function computeFileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

const baseManifest = {
  reef: '1.0',
  type: 'solo' as const,
  name: 'test-formation',
  version: '1.0.0',
  description: 'Test formation for diff tests',
  namespace: 'testns',
  agents: {
    helper: {
      source: 'agents/helper',
      description: 'A helper agent',
    },
  },
};

function makeState(overrides?: Partial<FormationState>): FormationState {
  const soulContent = 'You are a helper agent.';
  const soulHash = computeFileHash(Buffer.from(soulContent, 'utf-8'));

  return {
    name: 'test-formation',
    version: '1.0.0',
    namespace: 'testns',
    installedAt: new Date().toISOString(),
    agents: {
      helper: {
        id: 'testns-helper',
        slug: 'helper',
        workspace: join(tempHome, 'workspace-testns-helper'),
        files: ['SOUL.md'],
      },
    },
    bindings: [],
    cronJobs: [],
    variables: {},
    fileHashes: {
      'testns-helper:SOUL.md': soulHash,
    },
    agentToAgentEdges: {},
    ...overrides,
  };
}

async function writeState(state: FormationState): Promise<void> {
  const stateDir = join(tempHome, '.reef');
  await mkdir(stateDir, { recursive: true });
  const fileName = `${state.namespace}--${state.name}.state.json`;
  await writeFile(join(stateDir, fileName), JSON.stringify(state, null, 2));
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-diff-test-'));
  formationDir = join(tempHome, 'formation');

  await mkdir(formationDir, { recursive: true });
  await mkdir(join(formationDir, 'agents', 'helper'), { recursive: true });
  await writeFile(
    join(formationDir, 'agents', 'helper', 'SOUL.md'),
    'You are a helper agent.',
  );
  await writeFile(
    join(formationDir, 'reef.json'),
    JSON.stringify(baseManifest, null, 2),
  );

  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('reef diff', () => {
  it('no changes detected (installed state matches source)', async () => {
    const state = makeState();
    await writeState(state);

    const result = await computeFormationDiff(formationDir, {});

    expect(result.plan.isEmpty).toBe(true);
    expect(result.plan.versionChange).toBeNull();
    expect(result.plan.agents.every((a) => a.type === 'unchanged')).toBe(true);
  });

  it('detects added agent', async () => {
    const state = makeState();
    await writeState(state);

    // Add a new agent to the manifest and source files
    const manifestWithNewAgent = {
      ...baseManifest,
      type: 'shoal' as const,
      agents: {
        ...baseManifest.agents,
        reviewer: {
          source: 'agents/reviewer',
          description: 'A reviewer agent',
        },
      },
    };

    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify(manifestWithNewAgent, null, 2),
    );
    await mkdir(join(formationDir, 'agents', 'reviewer'), { recursive: true });
    await writeFile(
      join(formationDir, 'agents', 'reviewer', 'SOUL.md'),
      'You are a reviewer agent.',
    );

    const result = await computeFormationDiff(formationDir, {});

    expect(result.plan.isEmpty).toBe(false);
    const addedAgent = result.plan.agents.find((a) => a.type === 'add');
    expect(addedAgent).toBeDefined();
    expect(addedAgent!.slug).toBe('reviewer');
  });

  it('detects removed agent (state has agent not in new manifest)', async () => {
    // State has both helper and reviewer
    const soulContent = 'You are a reviewer agent.';
    const soulHash = computeFileHash(Buffer.from(soulContent, 'utf-8'));

    const state = makeState({
      agents: {
        helper: {
          id: 'testns-helper',
          slug: 'helper',
          workspace: join(tempHome, 'workspace-testns-helper'),
          files: ['SOUL.md'],
        },
        reviewer: {
          id: 'testns-reviewer',
          slug: 'reviewer',
          workspace: join(tempHome, 'workspace-testns-reviewer'),
          files: ['SOUL.md'],
        },
      },
      fileHashes: {
        'testns-helper:SOUL.md': computeFileHash(Buffer.from('You are a helper agent.', 'utf-8')),
        'testns-reviewer:SOUL.md': soulHash,
      },
    });
    await writeState(state);

    // Manifest only has helper (reviewer removed)
    const result = await computeFormationDiff(formationDir, {});

    expect(result.plan.isEmpty).toBe(false);
    const removedAgent = result.plan.agents.find((a) => a.type === 'remove');
    expect(removedAgent).toBeDefined();
    expect(removedAgent!.slug).toBe('reviewer');
  });

  it('detects changed files (hash differs)', async () => {
    const state = makeState();
    await writeState(state);

    // Modify the SOUL.md file content
    await writeFile(
      join(formationDir, 'agents', 'helper', 'SOUL.md'),
      'You are a COMPLETELY DIFFERENT helper agent now.',
    );

    const result = await computeFormationDiff(formationDir, {});

    expect(result.plan.isEmpty).toBe(false);
    const updatedAgent = result.plan.agents.find((a) => a.type === 'update');
    expect(updatedAgent).toBeDefined();
    expect(updatedAgent!.slug).toBe('helper');
    expect(updatedAgent!.changedFiles).toContain('SOUL.md');
  });

  it('detects version change', async () => {
    const state = makeState();
    await writeState(state);

    // Change version in manifest
    const manifestV2 = { ...baseManifest, version: '2.0.0' };
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify(manifestV2, null, 2),
    );

    const result = await computeFormationDiff(formationDir, {});

    expect(result.plan.versionChange).not.toBeNull();
    expect(result.plan.versionChange!.from).toBe('1.0.0');
    expect(result.plan.versionChange!.to).toBe('2.0.0');
  });

  it('errors when not installed (no state file)', async () => {
    // Do NOT write any state file

    await expect(
      computeFormationDiff(formationDir, {}),
    ).rejects.toThrow(DiffValidationError);
  });

  it('no binding diff when variable resolves to same value as state', async () => {
    // State has a literal resolved binding
    const state = makeState({
      bindings: [
        { agentId: 'testns-helper', match: { channel: 'slack:#ops' } },
      ],
    });
    await writeState(state);

    // Manifest uses a variable token for the binding channel
    const manifestWithVarBinding = {
      ...baseManifest,
      variables: {
        INTERACTION_CHANNEL: { type: 'string' as const },
      },
      bindings: [
        { channel: '{{INTERACTION_CHANNEL}}', agent: 'helper' },
      ],
    };
    await writeFile(
      join(formationDir, 'reef.json'),
      JSON.stringify(manifestWithVarBinding, null, 2),
    );

    // Provide the variable via .env so it resolves to the same value as state
    await writeFile(
      join(formationDir, '.env'),
      'INTERACTION_CHANNEL="slack:#ops"',
    );

    const result = await computeFormationDiff(formationDir, {});

    // No binding diff — resolved value matches state
    expect(result.plan.bindings).toHaveLength(0);
    expect(result.plan.isEmpty).toBe(true);
  });
});
