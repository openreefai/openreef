import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  readConfig,
  writeConfig,
  addAgentEntry,
  removeAgentEntry,
  addBinding,
  removeBinding,
  setAgentToAgent,
  removeAgentToAgent,
  bindingsEqual,
  extractChannelType,
  getConfiguredChannels,
  classifyBindings,
  resolveSelectedBindings,
  isBareChannel,
  expandCompoundChannel,
  ensureChannelAllowlisted,
  updateAgentEntry,
} from '../../src/core/config-patcher.js';
import type { OpenClawBinding } from '../../src/types/state.js';
import type { Binding } from '../../src/types/manifest.js';

let tempDir: string;

describe('config-patcher', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── readConfig ───────────────────────────────────────────────────
  describe('readConfig', () => {
    it('reads JSON5 config and returns parsed + raw + path', async () => {
      const configPath = join(tempDir, 'openclaw.json');
      const content = '{ "agents": { "list": [] }, "bindings": [] }';
      await writeFile(configPath, content);

      const result = await readConfig(configPath);
      expect(result.path).toBe(configPath);
      expect(result.raw).toBe(content);
      expect(result.config).toEqual({ agents: { list: [] }, bindings: [] });
    });

    it('returns empty config if file is missing', async () => {
      const configPath = join(tempDir, 'nonexistent.json');
      const result = await readConfig(configPath);
      expect(result.config).toEqual({ agents: { list: [] }, bindings: [] });
      expect(result.raw).toBe('');
      expect(result.path).toBe(configPath);
    });

    it('parses JSON5 with comments and trailing commas', async () => {
      const configPath = join(tempDir, 'openclaw.json');
      const json5Content = `{
  // This is a comment
  "agents": {
    "list": [
      { "id": "test", }, // trailing comma
    ],
  },
  "bindings": [],
}`;
      await writeFile(configPath, json5Content);

      const result = await readConfig(configPath);
      expect(result.config.agents).toBeDefined();
      const agents = result.config.agents as Record<string, unknown>;
      expect(Array.isArray(agents.list)).toBe(true);
      expect((agents.list as unknown[]).length).toBe(1);
    });
  });

  // ─── writeConfig ──────────────────────────────────────────────────
  describe('writeConfig', () => {
    it('writes JSON and creates .bak backup', async () => {
      const configPath = join(tempDir, 'openclaw.json');
      const originalContent = '{ "old": true }';
      await writeFile(configPath, originalContent);

      const newConfig = { agents: { list: [] }, bindings: [] };
      await writeConfig(configPath, newConfig, { silent: true });

      const written = await readFile(configPath, 'utf-8');
      expect(JSON.parse(written)).toEqual(newConfig);

      const bakPath = configPath + '.bak';
      expect(existsSync(bakPath)).toBe(true);
      const bakContent = await readFile(bakPath, 'utf-8');
      expect(bakContent).toBe(originalContent);
    });

    it('writes config even if no prior file exists (no .bak)', async () => {
      const configPath = join(tempDir, 'new-config.json');
      const config = { agents: { list: [] } };
      await writeConfig(configPath, config, { silent: true });

      const written = await readFile(configPath, 'utf-8');
      expect(JSON.parse(written)).toEqual(config);
      expect(existsSync(configPath + '.bak')).toBe(false);
    });
  });

  // ─── JSON5 regression test ────────────────────────────────────────
  describe('JSON5 regression', () => {
    it('read JSON5 with comments, write back as clean JSON, .bak preserves original', async () => {
      const configPath = join(tempDir, 'openclaw.json');
      const json5Content = `{
  // Gateway settings
  "gateway": {
    "port": 18789,
  },
  "agents": {
    "list": [
      {
        "id": "my-agent",
        "name": "My Agent", // inline comment
      },
    ],
  },
  "bindings": [],
}`;
      await writeFile(configPath, json5Content);

      // Read the JSON5 config
      const { config } = await readConfig(configPath);

      // Write it back as JSON
      await writeConfig(configPath, config, { silent: true });

      // Verify the output is valid JSON (no comments, no trailing commas)
      const written = await readFile(configPath, 'utf-8');
      expect(() => JSON.parse(written)).not.toThrow();
      const parsed = JSON.parse(written);
      expect(parsed.gateway.port).toBe(18789);
      expect((parsed.agents.list as unknown[])[0]).toMatchObject({
        id: 'my-agent',
        name: 'My Agent',
      });

      // Verify .bak file preserves original JSON5
      const bakContent = await readFile(configPath + '.bak', 'utf-8');
      expect(bakContent).toBe(json5Content);
      expect(bakContent).toContain('// Gateway settings');
      expect(bakContent).toContain('// inline comment');
    });
  });

  // ─── addAgentEntry ────────────────────────────────────────────────
  describe('addAgentEntry', () => {
    it('adds to agents.list[] and seeds main when list is empty', () => {
      const config: Record<string, unknown> = {};
      const env = { OPENCLAW_STATE_DIR: tempDir };
      addAgentEntry(config, { id: 'test-agent', name: 'Test Agent' }, env);

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('main');
      expect(list[1].id).toBe('test-agent');
      expect(list[1].name).toBe('Test Agent');
      expect(list[1].workspace).toBe(join(tempDir, 'workspace-test-agent'));
    });

    it('does NOT seed main when adding "main" directly', () => {
      const config: Record<string, unknown> = {};
      const env = { OPENCLAW_STATE_DIR: tempDir };
      addAgentEntry(config, { id: 'main' }, env);

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('main');
    });

    it('does NOT seed main when list already has entries', () => {
      const config: Record<string, unknown> = {
        agents: { list: [{ id: 'existing-agent' }] },
      };
      const env = { OPENCLAW_STATE_DIR: tempDir };
      addAgentEntry(config, { id: 'test-agent', name: 'Test Agent' }, env);

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('existing-agent');
      expect(list[1].id).toBe('test-agent');
    });

    it('is idempotent — no duplicate if same id', () => {
      const config: Record<string, unknown> = {};
      const env = { OPENCLAW_STATE_DIR: tempDir };
      addAgentEntry(config, { id: 'test-agent', name: 'Agent' }, env);
      addAgentEntry(config, { id: 'test-agent', name: 'Agent V2' }, env);

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      // main + test-agent = 2 (no duplicate)
      expect(list).toHaveLength(2);
    });

    it('is idempotent with case/whitespace variants', () => {
      const config: Record<string, unknown> = {};
      const env = { OPENCLAW_STATE_DIR: tempDir };
      addAgentEntry(config, { id: 'Test-Agent', name: 'Agent' }, env);
      addAgentEntry(config, { id: ' test-agent ', name: 'Agent V2' }, env);

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      // main + Test-Agent = 2 (no duplicate from case variant)
      expect(list).toHaveLength(2);
    });

    it('adds multiple agents with different ids', () => {
      const config: Record<string, unknown> = {};
      const env = { OPENCLAW_STATE_DIR: tempDir };
      addAgentEntry(config, { id: 'agent-a', name: 'A' }, env);
      addAgentEntry(config, { id: 'agent-b', name: 'B' }, env);

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      // main + agent-a + agent-b = 3
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('main');
    });
  });

  // ─── removeAgentEntry ─────────────────────────────────────────────
  describe('removeAgentEntry', () => {
    it('removes from agents.list[]', () => {
      const config: Record<string, unknown> = {
        agents: { list: [{ id: 'agent-a' }, { id: 'agent-b' }] },
      };
      removeAgentEntry(config, 'agent-a');

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('agent-b');
    });

    it('no-ops if agent not in list', () => {
      const config: Record<string, unknown> = {
        agents: { list: [{ id: 'agent-a' }] },
      };
      removeAgentEntry(config, 'nonexistent');

      const agents = config.agents as Record<string, unknown>;
      const list = agents.list as Record<string, unknown>[];
      expect(list).toHaveLength(1);
    });
  });

  // ─── addBinding ───────────────────────────────────────────────────
  describe('addBinding', () => {
    const binding: OpenClawBinding = {
      agentId: 'ns-worker',
      match: { channel: 'slack', accountId: 'T123' },
    };

    it('adds to bindings[]', () => {
      const config: Record<string, unknown> = {};
      addBinding(config, binding);

      const bindings = config.bindings as OpenClawBinding[];
      expect(bindings).toHaveLength(1);
      expect(bindings[0].agentId).toBe('ns-worker');
    });

    it('is idempotent', () => {
      const config: Record<string, unknown> = {};
      addBinding(config, binding);
      addBinding(config, binding);

      const bindings = config.bindings as OpenClawBinding[];
      expect(bindings).toHaveLength(1);
    });
  });

  // ─── removeBinding ────────────────────────────────────────────────
  describe('removeBinding', () => {
    const binding: OpenClawBinding = {
      agentId: 'ns-worker',
      match: { channel: 'slack', accountId: 'T123' },
    };

    it('removes from bindings[]', () => {
      const config: Record<string, unknown> = { bindings: [binding] };
      removeBinding(config, binding);

      const bindings = config.bindings as OpenClawBinding[];
      expect(bindings).toHaveLength(0);
    });

    it('no-ops if binding not present', () => {
      const config: Record<string, unknown> = { bindings: [] };
      removeBinding(config, binding);

      const bindings = config.bindings as OpenClawBinding[];
      expect(bindings).toHaveLength(0);
    });
  });

  // ─── setAgentToAgent ──────────────────────────────────────────────
  describe('setAgentToAgent', () => {
    it('sets enabled=true and merges namespace pattern into allow list', () => {
      const config: Record<string, unknown> = {};
      setAgentToAgent(config, 'myns');

      const tools = config.tools as Record<string, unknown>;
      const a2a = tools.agentToAgent as Record<string, unknown>;
      expect(a2a.enabled).toBe(true);
      expect(a2a.allow).toContain('myns-*');
    });

    it('is idempotent — does not duplicate pattern', () => {
      const config: Record<string, unknown> = {};
      setAgentToAgent(config, 'myns');
      setAgentToAgent(config, 'myns');

      const tools = config.tools as Record<string, unknown>;
      const a2a = tools.agentToAgent as Record<string, unknown>;
      const allow = a2a.allow as string[];
      expect(allow.filter((p) => p === 'myns-*')).toHaveLength(1);
    });

    it('preserves existing allow entries', () => {
      const config: Record<string, unknown> = {
        tools: { agentToAgent: { enabled: true, allow: ['other-*'] } },
      };
      setAgentToAgent(config, 'myns');

      const tools = config.tools as Record<string, unknown>;
      const a2a = tools.agentToAgent as Record<string, unknown>;
      const allow = a2a.allow as string[];
      expect(allow).toContain('other-*');
      expect(allow).toContain('myns-*');
    });
  });

  // ─── removeAgentToAgent ───────────────────────────────────────────
  describe('removeAgentToAgent', () => {
    it('removes namespace pattern from allow list', () => {
      const config: Record<string, unknown> = {
        tools: { agentToAgent: { enabled: true, allow: ['myns-*', 'other-*'] } },
      };
      removeAgentToAgent(config, 'myns', false);

      const tools = config.tools as Record<string, unknown>;
      const a2a = tools.agentToAgent as Record<string, unknown>;
      const allow = a2a.allow as string[];
      expect(allow).not.toContain('myns-*');
      expect(allow).toContain('other-*');
    });

    it('disables when wasEnabled=false and no other formations in namespace', () => {
      const config: Record<string, unknown> = {
        tools: { agentToAgent: { enabled: true, allow: ['myns-*'] } },
      };
      removeAgentToAgent(config, 'myns', false, false);

      const tools = config.tools as Record<string, unknown>;
      const a2a = tools.agentToAgent as Record<string, unknown>;
      expect(a2a.enabled).toBe(false);
    });

    it('keeps enabled when other formations exist in namespace', () => {
      const config: Record<string, unknown> = {
        tools: { agentToAgent: { enabled: true, allow: ['myns-*'] } },
      };
      removeAgentToAgent(config, 'myns', true, false);

      const tools = config.tools as Record<string, unknown>;
      const a2a = tools.agentToAgent as Record<string, unknown>;
      // When otherFormationsInNamespace is true, pattern is not removed
      const allow = a2a.allow as string[];
      expect(allow).toContain('myns-*');
    });
  });

  // ─── bindingsEqual ────────────────────────────────────────────────
  describe('bindingsEqual', () => {
    it('returns true for equivalent bindings regardless of key order', () => {
      const a: OpenClawBinding = {
        agentId: 'ns-worker',
        match: { channel: 'slack', accountId: 'T123' },
      };
      const b: OpenClawBinding = {
        match: { accountId: 'T123', channel: 'slack' },
        agentId: 'ns-worker',
      };
      expect(bindingsEqual(a, b)).toBe(true);
    });

    it('returns false for different bindings', () => {
      const a: OpenClawBinding = {
        agentId: 'ns-worker',
        match: { channel: 'slack' },
      };
      const b: OpenClawBinding = {
        agentId: 'ns-worker',
        match: { channel: 'discord' },
      };
      expect(bindingsEqual(a, b)).toBe(false);
    });

    it('returns false when agentIds differ', () => {
      const a: OpenClawBinding = {
        agentId: 'ns-a',
        match: { channel: 'slack' },
      };
      const b: OpenClawBinding = {
        agentId: 'ns-b',
        match: { channel: 'slack' },
      };
      expect(bindingsEqual(a, b)).toBe(false);
    });
  });

  // ─── extractChannelType ──────────────────────────────────────────
  describe('extractChannelType', () => {
    it('extracts bare channel name', () => {
      expect(extractChannelType('telegram')).toBe('telegram');
    });

    it('extracts channel type before colon', () => {
      expect(extractChannelType('slack:#support')).toBe('slack');
    });

    it('handles multiple colons (splits on first)', () => {
      expect(extractChannelType('discord:guild:channel')).toBe('discord');
    });

    it('normalizes case', () => {
      expect(extractChannelType('Slack:#Support')).toBe('slack');
    });

    it('trims whitespace', () => {
      expect(extractChannelType('  slack  ')).toBe('slack');
      expect(extractChannelType('  Telegram:#chat  ')).toBe('telegram');
    });
  });

  // ─── getConfiguredChannels ───────────────────────────────────────
  describe('getConfiguredChannels', () => {
    it('returns null when no channels section', () => {
      expect(getConfiguredChannels({})).toBeNull();
    });

    it('returns null for non-object channels (malformed guard)', () => {
      expect(getConfiguredChannels({ channels: 'bad' })).toBeNull();
      expect(getConfiguredChannels({ channels: 42 })).toBeNull();
      expect(getConfiguredChannels({ channels: true })).toBeNull();
      expect(getConfiguredChannels({ channels: null })).toBeNull();
    });

    it('returns null for array channels (malformed guard)', () => {
      expect(getConfiguredChannels({ channels: ['slack'] })).toBeNull();
    });

    it('returns enabled channels', () => {
      const result = getConfiguredChannels({
        channels: {
          slack: { enabled: true, token: 'xoxb-...' },
          telegram: { botToken: '123:ABC' },
        },
      });
      expect(result).toEqual(new Set(['slack', 'telegram']));
    });

    it('excludes explicitly disabled channels', () => {
      const result = getConfiguredChannels({
        channels: {
          slack: { enabled: false },
          telegram: { enabled: true },
        },
      });
      expect(result).toEqual(new Set(['telegram']));
    });

    it('treats missing enabled field as enabled', () => {
      const result = getConfiguredChannels({
        channels: {
          telegram: { botToken: '123:ABC' },
        },
      });
      expect(result).toEqual(new Set(['telegram']));
    });

    it('excludes the defaults key', () => {
      const result = getConfiguredChannels({
        channels: {
          defaults: { timeout: 30 },
          slack: { enabled: true },
        },
      });
      expect(result).toEqual(new Set(['slack']));
      expect(result!.has('defaults')).toBe(false);
    });

    it('treats non-object provider entry as configured', () => {
      const result = getConfiguredChannels({
        channels: { slack: true },
      });
      expect(result).toEqual(new Set(['slack']));
    });
  });

  // ─── isBareChannel ──────────────────────────────────────────────
  describe('isBareChannel', () => {
    it('returns true for bare channel names', () => {
      expect(isBareChannel('telegram')).toBe(true);
      expect(isBareChannel(' telegram ')).toBe(true);
      expect(isBareChannel('slack')).toBe(true);
    });

    it('returns false for scoped channel names', () => {
      expect(isBareChannel('telegram:group-123')).toBe(false);
      expect(isBareChannel('slack:#support')).toBe(false);
      expect(isBareChannel('discord:guild:channel')).toBe(false);
    });
  });

  // ─── classifyBindings ────────────────────────────────────────────
  describe('classifyBindings', () => {
    const bindings: Binding[] = [
      { match: { channel: 'slack', peer: { kind: 'channel', id: '#support' } }, agent: 'triage' },
      { match: { channel: 'telegram' }, agent: 'triage' },
    ];

    it('marks all as unknown when configuredChannels is null', () => {
      const result = classifyBindings(bindings, null);
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('unknown');
      expect(result[1].status).toBe('unknown');
    });

    it('correctly classifies configured and unconfigured bindings', () => {
      const channels = new Set(['telegram']);
      const result = classifyBindings(bindings, channels);
      expect(result[0].status).toBe('unconfigured'); // slack
      expect(result[0].channelType).toBe('slack');
      expect(result[1].status).toBe('configured'); // telegram
      expect(result[1].channelType).toBe('telegram');
    });

    it('extracts channel type from compound strings', () => {
      const result = classifyBindings(
        [{ match: { channel: 'discord', peer: { kind: 'channel', id: 'general' } }, agent: 'bot' }],
        new Set(['discord']),
      );
      expect(result[0].channelType).toBe('discord');
      expect(result[0].status).toBe('configured');
    });

    it('sets isBare to false for all match-object bindings', () => {
      const result = classifyBindings(bindings, null);
      expect(result[0].isBare).toBe(false); // slack with peer
      expect(result[1].isBare).toBe(false); // telegram without peer — still not bare (match objects are intentional)
    });
  });

  // ─── resolveSelectedBindings ─────────────────────────────────────
  describe('resolveSelectedBindings', () => {
    it('keeps configured and unknown, drops unconfigured and bare', () => {
      const classified = [
        { binding: { match: { channel: 'slack', peer: { kind: 'channel' as const, id: '#support' } }, agent: 'a' }, channelType: 'slack', status: 'configured' as const, isBare: false },
        { binding: { match: { channel: 'telegram' }, agent: 'b' }, channelType: 'telegram', status: 'unconfigured' as const, isBare: true },
        { binding: { match: { channel: 'discord', peer: { kind: 'channel' as const, id: 'general' } }, agent: 'c' }, channelType: 'discord', status: 'unknown' as const, isBare: false },
      ];
      const result = resolveSelectedBindings(classified);
      expect(result).toHaveLength(2);
      expect(result[0].match.channel).toBe('slack');
      expect(result[1].match.channel).toBe('discord');
    });

    it('filters bare bindings by default', () => {
      const classified = [
        { binding: { match: { channel: 'slack', peer: { kind: 'channel' as const, id: '#support' } }, agent: 'a' }, channelType: 'slack', status: 'configured' as const, isBare: false },
        { binding: { match: { channel: 'telegram' }, agent: 'b' }, channelType: 'telegram', status: 'configured' as const, isBare: true },
      ];
      const result = resolveSelectedBindings(classified);
      expect(result).toHaveLength(1);
      expect(result[0].match.channel).toBe('slack');
    });

    it('keeps bare bindings with allowChannelShadow', () => {
      const classified = [
        { binding: { match: { channel: 'slack', peer: { kind: 'channel' as const, id: '#support' } }, agent: 'a' }, channelType: 'slack', status: 'configured' as const, isBare: false },
        { binding: { match: { channel: 'telegram' }, agent: 'b' }, channelType: 'telegram', status: 'configured' as const, isBare: true },
      ];
      const result = resolveSelectedBindings(classified, { allowChannelShadow: true });
      expect(result).toHaveLength(2);
      expect(result[0].match.channel).toBe('slack');
      expect(result[1].match.channel).toBe('telegram');
    });

    it('returns empty for empty input', () => {
      expect(resolveSelectedBindings([])).toEqual([]);
    });

    it('returns empty when all are unconfigured', () => {
      const classified = [
        { binding: { match: { channel: 'slack' }, agent: 'a' }, channelType: 'slack', status: 'unconfigured' as const, isBare: true },
        { binding: { match: { channel: 'telegram' }, agent: 'b' }, channelType: 'telegram', status: 'unconfigured' as const, isBare: true },
      ];
      expect(resolveSelectedBindings(classified)).toEqual([]);
    });

    it('keeps scoped unknown bindings, drops bare unknown', () => {
      const classified = [
        { binding: { match: { channel: 'slack', peer: { kind: 'channel' as const, id: '#support' } }, agent: 'a' }, channelType: 'slack', status: 'unknown' as const, isBare: false },
        { binding: { match: { channel: 'telegram' }, agent: 'b' }, channelType: 'telegram', status: 'unknown' as const, isBare: true },
      ];
      const result = resolveSelectedBindings(classified);
      expect(result).toHaveLength(1);
      expect(result[0].match.channel).toBe('slack');
    });
  });

  // ─── expandCompoundChannel ────────────────────────────────────
  describe('expandCompoundChannel', () => {
    it('expands discord:<id> into channel + peer', () => {
      const result = expandCompoundChannel({ channel: 'discord:1473055080470155425' });
      expect(result.channel).toBe('discord');
      expect(result.peer).toEqual({ kind: 'channel', id: '1473055080470155425' });
    });

    it('expands slack:#ops into channel + peer', () => {
      const result = expandCompoundChannel({ channel: 'slack:#ops' });
      expect(result.channel).toBe('slack');
      expect(result.peer).toEqual({ kind: 'channel', id: '#ops' });
    });

    it('expands telegram:12345 into channel + peer', () => {
      const result = expandCompoundChannel({ channel: 'telegram:12345' });
      expect(result.channel).toBe('telegram');
      expect(result.peer).toEqual({ kind: 'channel', id: '12345' });
    });

    it('does not expand bare channel names (no colon)', () => {
      const result = expandCompoundChannel({ channel: 'discord' });
      expect(result.channel).toBe('discord');
      expect(result.peer).toBeUndefined();
    });

    it('does not expand if peer is already set', () => {
      const result = expandCompoundChannel({
        channel: 'discord:1234',
        peer: { kind: 'direct', id: '9999' },
      });
      expect(result.channel).toBe('discord:1234');
      expect(result.peer).toEqual({ kind: 'direct', id: '9999' });
    });

    it('preserves other match fields during expansion', () => {
      const result = expandCompoundChannel({
        channel: 'discord:1234',
        guildId: 'g-100',
        accountId: 'acct-1',
      });
      expect(result.channel).toBe('discord');
      expect(result.peer).toEqual({ kind: 'channel', id: '1234' });
      expect(result.guildId).toBe('g-100');
      expect(result.accountId).toBe('acct-1');
    });

    it('handles empty scope after colon — no expansion', () => {
      const result = expandCompoundChannel({ channel: 'discord:' });
      expect(result.channel).toBe('discord:');
      expect(result.peer).toBeUndefined();
    });

    it('handles non-string channel — returns as-is', () => {
      const result = expandCompoundChannel({ channel: 42 as unknown as string });
      expect(result.channel).toBe(42);
    });
  });

  // ─── ensureChannelAllowlisted ─────────────────────────────────
  describe('ensureChannelAllowlisted', () => {
    it('adds discord channel to all configured guilds', () => {
      const config: Record<string, unknown> = {
        channels: {
          discord: {
            guilds: {
              'guild-1': { slug: 'my-guild' },
              'guild-2': { slug: 'other-guild' },
            },
          },
        },
      };
      const binding: OpenClawBinding = {
        agentId: 'ns-bot',
        match: { channel: 'discord', peer: { kind: 'channel', id: '1473055080470155425' } },
      };
      ensureChannelAllowlisted(config, binding);

      const guild1 = (config.channels as any).discord.guilds['guild-1'];
      const guild2 = (config.channels as any).discord.guilds['guild-2'];
      expect(guild1.channels['1473055080470155425']).toEqual({ allow: true });
      expect(guild2.channels['1473055080470155425']).toEqual({ allow: true });
    });

    it('targets specific guild when guildId is in the binding match', () => {
      const config: Record<string, unknown> = {
        channels: {
          discord: {
            guilds: {
              'guild-1': { slug: 'my-guild' },
              'guild-2': { slug: 'other-guild' },
            },
          },
        },
      };
      const binding: OpenClawBinding = {
        agentId: 'ns-bot',
        match: {
          channel: 'discord',
          peer: { kind: 'channel', id: '1234' },
          guildId: 'guild-1',
        },
      };
      ensureChannelAllowlisted(config, binding);

      const guild1 = (config.channels as any).discord.guilds['guild-1'];
      const guild2 = (config.channels as any).discord.guilds['guild-2'];
      expect(guild1.channels['1234']).toEqual({ allow: true });
      expect(guild2.channels).toBeUndefined(); // Not touched
    });

    it('does not overwrite existing channel config', () => {
      const config: Record<string, unknown> = {
        channels: {
          discord: {
            guilds: {
              'guild-1': {
                channels: {
                  '1234': { allow: true, requireMention: false, users: ['admin'] },
                },
              },
            },
          },
        },
      };
      const binding: OpenClawBinding = {
        agentId: 'ns-bot',
        match: { channel: 'discord', peer: { kind: 'channel', id: '1234' } },
      };
      ensureChannelAllowlisted(config, binding);

      const entry = (config.channels as any).discord.guilds['guild-1'].channels['1234'];
      expect(entry).toEqual({ allow: true, requireMention: false, users: ['admin'] });
    });

    it('no-ops for non-discord channels', () => {
      const config: Record<string, unknown> = {
        channels: {
          slack: { enabled: true },
        },
      };
      const binding: OpenClawBinding = {
        agentId: 'ns-bot',
        match: { channel: 'slack', peer: { kind: 'channel', id: '#ops' } },
      };
      const before = JSON.stringify(config);
      ensureChannelAllowlisted(config, binding);
      expect(JSON.stringify(config)).toBe(before);
    });

    it('no-ops when no guilds are configured', () => {
      const config: Record<string, unknown> = {
        channels: { discord: { enabled: true } },
      };
      const binding: OpenClawBinding = {
        agentId: 'ns-bot',
        match: { channel: 'discord', peer: { kind: 'channel', id: '1234' } },
      };
      const before = JSON.stringify(config);
      ensureChannelAllowlisted(config, binding);
      expect(JSON.stringify(config)).toBe(before);
    });

    it('no-ops when binding has no peer', () => {
      const config: Record<string, unknown> = {
        channels: {
          discord: {
            guilds: { 'guild-1': {} },
          },
        },
      };
      const binding: OpenClawBinding = {
        agentId: 'ns-bot',
        match: { channel: 'discord' },
      };
      const before = JSON.stringify(config);
      ensureChannelAllowlisted(config, binding);
      expect(JSON.stringify(config)).toBe(before);
    });
  });

  describe('updateAgentEntry', () => {
    it('updates tools on an existing agent', () => {
      const config: Record<string, unknown> = {
        agents: {
          list: [
            {
              id: 'reef-forge-architect',
              name: 'architect',
              workspace: '/tmp/ws',
              model: 'anthropic/claude-opus-4-6',
              tools: { allow: ['web_search', 'read', 'write', 'sessions_send'] },
            },
          ],
        },
      };

      const result = updateAgentEntry(config, 'reef-forge-architect', {
        model: 'anthropic/claude-opus-4-6',
        tools: { allow: ['web_search', 'web_fetch', 'read', 'write', 'sessions_spawn', 'sessions_send', 'sessions_list'] },
      });

      const list = (result.agents as Record<string, unknown>).list as Record<string, unknown>[];
      const agent = list.find((a) => a.id === 'reef-forge-architect')!;
      expect(agent.tools).toEqual({
        allow: ['web_search', 'web_fetch', 'read', 'write', 'sessions_spawn', 'sessions_send', 'sessions_list'],
      });
    });

    it('returns config unchanged when agent not found', () => {
      const config: Record<string, unknown> = {
        agents: {
          list: [
            { id: 'some-other-agent', name: 'other', tools: { allow: ['read'] } },
          ],
        },
      };

      const result = updateAgentEntry(config, 'nonexistent-agent', {
        tools: { allow: ['write'] },
      });

      const list = (result.agents as Record<string, unknown>).list as Record<string, unknown>[];
      expect(list[0].tools).toEqual({ allow: ['read'] });
    });

    it('persists through writeConfig round-trip', async () => {
      const configPath = join(tempDir, 'update-test.json');
      const config = {
        agents: {
          list: [
            {
              id: 'reef-forge-architect',
              name: 'architect',
              workspace: '/tmp/ws',
              tools: { allow: ['web_search', 'sessions_send'] },
            },
          ],
        },
      };
      await writeFile(configPath, JSON.stringify(config));

      const { config: loaded } = await readConfig(configPath);
      const patched = updateAgentEntry(loaded, 'reef-forge-architect', {
        tools: { allow: ['web_search', 'web_fetch', 'sessions_spawn', 'sessions_send'] },
      });
      await writeConfig(configPath, patched, { silent: true });

      const raw = JSON.parse(await readFile(configPath, 'utf-8'));
      const agent = raw.agents.list.find((a: Record<string, unknown>) => a.id === 'reef-forge-architect');
      expect(agent.tools.allow).toContain('sessions_spawn');
      expect(agent.tools.allow).toContain('web_fetch');
    });

    it('merges subagents.allowAgents without dropping existing subagent model', () => {
      const config: Record<string, unknown> = {
        agents: {
          list: [
            {
              id: 'reef-forge-architect',
              name: 'architect',
              workspace: '/tmp/ws',
              subagents: { model: 'anthropic/claude-opus-4-6' },
            },
          ],
        },
      };

      const result = updateAgentEntry(config, 'reef-forge-architect', {
        subagents: { allowAgents: ['reef-forge-researcher', 'reef-forge-builder'] },
      });

      const list = (result.agents as Record<string, unknown>).list as Record<string, unknown>[];
      const agent = list.find((a) => a.id === 'reef-forge-architect')!;
      expect(agent.subagents).toEqual({
        model: 'anthropic/claude-opus-4-6',
        allowAgents: ['reef-forge-researcher', 'reef-forge-builder'],
      });
    });
  });
});
