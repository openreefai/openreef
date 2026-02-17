import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Variable } from '../../src/types/manifest.js';

// Top-level mock -- intercepts all spawnSync calls in variable-hints.ts.
// Required because buildGitHubHint calls probeGitHubLogin via a lexical
// reference that vi.spyOn cannot intercept in ESM.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 1,
    stdout: '',
    stderr: '',
    pid: 0,
    output: [],
    signal: null,
  })),
}));

import { spawnSync } from 'node:child_process';
import { getVariableHint, probeGitHubLogin } from '../../src/core/variable-hints.js';
import type { VariableHintContext } from '../../src/core/variable-hints.js';

let tempHome: string;
let ctx: VariableHintContext;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-gh-hints-test-'));
  ctx = {
    formationPath: join(tempHome, 'formation'),
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: tempHome,
      OPENCLAW_CONFIG_PATH: join(tempHome, 'openclaw.json'),
    },
    interactive: true,
    allowExternalCommands: false,
    allowConfigMutation: false,
  };
  await writeFile(
    join(tempHome, 'openclaw.json'),
    JSON.stringify({ agents: { list: [] }, bindings: [] }),
  );
  vi.mocked(spawnSync).mockReset();
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

describe('probeGitHubLogin', () => {
  it('returns login when gh succeeds with valid username', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'jfeinblum\n',
      stderr: '',
      pid: 1,
      output: ['', 'jfeinblum\n', ''],
      signal: null,
    });

    expect(probeGitHubLogin(ctx.env)).toBe('jfeinblum');
  });

  it('returns null when gh exits non-zero', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not logged in',
      pid: 1,
      output: [],
      signal: null,
    });

    expect(probeGitHubLogin(ctx.env)).toBeNull();
  });

  it('returns null when gh returns garbage (fails login regex)', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '<html>login page</html>\n',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    expect(probeGitHubLogin(ctx.env)).toBeNull();
  });

  it('returns null when gh throws (not installed)', () => {
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(probeGitHubLogin(ctx.env)).toBeNull();
  });
});

describe('getVariableHint for GITHUB_USERNAME', () => {
  it('returns PrefillHint when gh succeeds with valid login', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'jfeinblum\n',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const config: Variable = { type: 'string', required: true };
    const hint = await getVariableHint('GITHUB_USERNAME', config, ctx);
    expect(hint).not.toBeNull();
    expect(hint!.kind).toBe('prefill');
    if (hint!.kind === 'prefill') {
      expect(hint.defaultValue).toBe('jfeinblum');
      expect(hint.source).toBe('GitHub CLI');
    }
  });

  it('returns null when gh fails', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const config: Variable = { type: 'string', required: true };
    const hint = await getVariableHint('GITHUB_USERNAME', config, ctx);
    expect(hint).toBeNull();
  });

  it('returns null for GITHUB_USERNAME with type number', async () => {
    const config: Variable = { type: 'number', required: true };
    const hint = await getVariableHint('GITHUB_USERNAME', config, ctx);
    expect(hint).toBeNull();
  });
});
