import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Variable } from '../../src/types/manifest.js';
import { getVariableHint } from '../../src/core/variable-hints.js';
import type { VariableHintContext } from '../../src/core/variable-hints.js';

let tempHome: string;
let ctx: VariableHintContext;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-hints-test-'));
  ctx = {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: tempHome,
      OPENCLAW_CONFIG_PATH: join(tempHome, 'openclaw.json'),
    },
  };
  await writeFile(
    join(tempHome, 'openclaw.json'),
    JSON.stringify({ agents: { list: [] }, bindings: [] }),
  );
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

describe('getVariableHint', () => {
  describe('detection rules', () => {
    it('returns ChannelHint for _CHANNEL suffix with type string', async () => {
      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      expect(hint).not.toBeNull();
      expect(hint!.kind).toBe('channel');
    });

    it('returns null for _CHANNEL suffix with type number', async () => {
      const config: Variable = { type: 'number', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      expect(hint).toBeNull();
    });

    it('returns null for unrecognized variable names', async () => {
      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('RANDOM_VAR', config, ctx);
      expect(hint).toBeNull();
    });

    it('matches any _CHANNEL suffix', async () => {
      const config: Variable = { type: 'string' };
      const hint = await getVariableHint('BRIEFING_CHANNEL', config, ctx);
      expect(hint).not.toBeNull();
      expect(hint!.kind).toBe('channel');
    });
  });

  describe('channel hint: recent channels', () => {
    it('builds recent channels from installed formation state', async () => {
      const stateDir = join(tempHome, '.reef');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'ops--daily-ops.state.json'),
        JSON.stringify({
          name: 'daily-ops',
          version: '0.4.0',
          namespace: 'ops',
          installedAt: '2026-02-16T10:00:00Z',
          agents: {},
          bindings: [
            { agentId: 'ops-chief', match: { channel: 'slack:#ops' } },
          ],
          cronJobs: [],
          variables: {},
          fileHashes: {},
        }),
      );

      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      expect(hint!.kind).toBe('channel');
      if (hint!.kind === 'channel') {
        expect(hint.recentChannels).toContainEqual(
          expect.objectContaining({ value: 'slack:#ops' }),
        );
      }
    });

    it('skips bare channels in recent list', async () => {
      const stateDir = join(tempHome, '.reef');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'ns--test.state.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          namespace: 'ns',
          installedAt: '2026-02-16T10:00:00Z',
          agents: {},
          bindings: [
            { agentId: 'ns-agent', match: { channel: 'telegram' } },
          ],
          cronJobs: [],
          variables: {},
          fileHashes: {},
        }),
      );

      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      if (hint!.kind === 'channel') {
        expect(hint.recentChannels).toHaveLength(0);
      }
    });

    it('deduplicates and sorts by installedAt desc, caps at 5', async () => {
      const stateDir = join(tempHome, '.reef');
      await mkdir(stateDir, { recursive: true });

      for (let i = 0; i < 7; i++) {
        await writeFile(
          join(stateDir, `ns--formation-${i}.state.json`),
          JSON.stringify({
            name: `formation-${i}`,
            version: '1.0.0',
            namespace: 'ns',
            installedAt: `2026-02-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
            agents: {},
            bindings: [
              {
                agentId: `ns-agent-${i}`,
                match: { channel: `slack:#ch-${i}` },
              },
            ],
            cronJobs: [],
            variables: {},
            fileHashes: {},
          }),
        );
      }
      // Duplicate channel on a different formation
      await writeFile(
        join(stateDir, 'ns--dup.state.json'),
        JSON.stringify({
          name: 'dup',
          version: '1.0.0',
          namespace: 'ns',
          installedAt: '2026-02-20T00:00:00Z',
          agents: {},
          bindings: [
            { agentId: 'ns-dup', match: { channel: 'slack:#ch-6' } },
          ],
          cronJobs: [],
          variables: {},
          fileHashes: {},
        }),
      );

      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      if (hint!.kind === 'channel') {
        expect(hint.recentChannels.length).toBeLessThanOrEqual(5);
        expect(hint.recentChannels[0].value).toBe('slack:#ch-6');
        const values = hint.recentChannels.map((c) => c.value);
        expect(new Set(values).size).toBe(values.length);
      }
    });
  });

  describe('channel hint: configured types', () => {
    it('reads configured types from OpenClaw config', async () => {
      await writeFile(
        join(tempHome, 'openclaw.json'),
        JSON.stringify({
          agents: { list: [] },
          bindings: [],
          channels: {
            slack: { enabled: true, token: 'xoxb-test' },
            telegram: { botToken: '123:ABC' },
          },
        }),
      );

      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      if (hint!.kind === 'channel') {
        expect(hint.configuredTypes).toContain('slack');
        expect(hint.configuredTypes).toContain('telegram');
      }
    });

    it('excludes types already in recent channels', async () => {
      await writeFile(
        join(tempHome, 'openclaw.json'),
        JSON.stringify({
          agents: { list: [] },
          bindings: [],
          channels: { slack: { enabled: true } },
        }),
      );
      const stateDir = join(tempHome, '.reef');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'ns--test.state.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          namespace: 'ns',
          installedAt: '2026-02-16T00:00:00Z',
          agents: {},
          bindings: [
            { agentId: 'ns-agent', match: { channel: 'slack:#ops' } },
          ],
          cronJobs: [],
          variables: {},
          fileHashes: {},
        }),
      );

      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      if (hint!.kind === 'channel') {
        expect(hint.configuredTypes).not.toContain('slack');
      }
    });

    it('returns empty arrays when no config and no state', async () => {
      const config: Variable = { type: 'string', required: true };
      const hint = await getVariableHint('INTERACTION_CHANNEL', config, ctx);
      if (hint!.kind === 'channel') {
        expect(hint.recentChannels).toHaveLength(0);
        expect(hint.configuredTypes).toHaveLength(0);
      }
    });
  });
});
