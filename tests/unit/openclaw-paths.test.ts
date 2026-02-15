import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveHomeDir,
  resolveStateDir,
  resolveConfigPath,
  resolveWorkspacePath,
  resolveReefStateDir,
  resolveGatewayUrl,
  validateAgentId,
  validateAgentIds,
} from '../../src/core/openclaw-paths.js';
import { writeFileSync, mkdirSync } from 'node:fs';

let tempDir: string;

describe('openclaw-paths', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-paths-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── resolveHomeDir ───────────────────────────────────────────────
  describe('resolveHomeDir', () => {
    it('uses OPENCLAW_HOME when set', () => {
      const env = { OPENCLAW_HOME: '/custom/home' };
      expect(resolveHomeDir(env)).toBe('/custom/home');
    });

    it('OPENCLAW_HOME takes precedence over HOME', () => {
      const env = { OPENCLAW_HOME: '/custom/home', HOME: '/other/home' };
      expect(resolveHomeDir(env)).toBe('/custom/home');
    });

    it('performs tilde expansion', () => {
      const env = { OPENCLAW_HOME: '~/subdir' };
      const result = resolveHomeDir(env);
      expect(result).not.toContain('~');
      expect(result).toContain('subdir');
    });

    it('falls back to HOME when OPENCLAW_HOME is not set', () => {
      const env = { HOME: '/fallback/home' };
      expect(resolveHomeDir(env)).toBe('/fallback/home');
    });

    it('falls back to USERPROFILE when HOME is not set', () => {
      const env = { USERPROFILE: 'C:\\Users\\test' };
      expect(resolveHomeDir(env)).toBe('C:\\Users\\test');
    });

    it('falls back to os.homedir() when no env vars set', () => {
      const result = resolveHomeDir({});
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  // ─── resolveStateDir ──────────────────────────────────────────────
  describe('resolveStateDir', () => {
    it('uses OPENCLAW_STATE_DIR when set', () => {
      const env = { OPENCLAW_STATE_DIR: '/my/state' };
      expect(resolveStateDir(env)).toBe('/my/state');
    });

    it('uses CLAWDBOT_STATE_DIR as legacy alias', () => {
      const env = { CLAWDBOT_STATE_DIR: '/legacy/state' };
      expect(resolveStateDir(env)).toBe('/legacy/state');
    });

    it('OPENCLAW_STATE_DIR takes precedence over CLAWDBOT_STATE_DIR', () => {
      const env = {
        OPENCLAW_STATE_DIR: '/primary',
        CLAWDBOT_STATE_DIR: '/legacy',
      };
      expect(resolveStateDir(env)).toBe('/primary');
    });

    it('checks ~/.openclaw/ if it exists', () => {
      const openclawDir = join(tempDir, '.openclaw');
      mkdirSync(openclawDir, { recursive: true });
      const env = { HOME: tempDir };
      expect(resolveStateDir(env)).toBe(openclawDir);
    });

    it('checks legacy dirs if .openclaw does not exist', () => {
      const legacyDir = join(tempDir, '.clawdbot');
      mkdirSync(legacyDir, { recursive: true });
      const env = { HOME: tempDir };
      expect(resolveStateDir(env)).toBe(legacyDir);
    });

    it('defaults to ~/.openclaw/ when nothing exists', () => {
      const env = { HOME: tempDir };
      expect(resolveStateDir(env)).toBe(join(tempDir, '.openclaw'));
    });
  });

  // ─── resolveConfigPath ────────────────────────────────────────────
  describe('resolveConfigPath', () => {
    it('uses OPENCLAW_CONFIG_PATH when set', () => {
      const env = { OPENCLAW_CONFIG_PATH: '/explicit/config.json' };
      expect(resolveConfigPath(env)).toBe('/explicit/config.json');
    });

    it('searches state dir for config files', () => {
      const stateDir = join(tempDir, '.openclaw');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'openclaw.json'), '{}');
      const env = { OPENCLAW_STATE_DIR: stateDir };
      expect(resolveConfigPath(env)).toBe(join(stateDir, 'openclaw.json'));
    });

    it('finds legacy config filenames in state dir', () => {
      const stateDir = join(tempDir, '.openclaw');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'clawdbot.json'), '{}');
      const env = { OPENCLAW_STATE_DIR: stateDir };
      expect(resolveConfigPath(env)).toBe(join(stateDir, 'clawdbot.json'));
    });

    it('explicit state dir skips home search and returns canonical path', () => {
      const stateDir = join(tempDir, 'custom-state');
      mkdirSync(stateDir, { recursive: true });
      // No config file in stateDir — should return canonical path
      const env = { OPENCLAW_STATE_DIR: stateDir };
      expect(resolveConfigPath(env)).toBe(join(stateDir, 'openclaw.json'));
    });

    it('fallback candidate search across home dirs', () => {
      // Create a legacy dir with a config in it
      const legacyDir = join(tempDir, '.clawdbot');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, 'clawdbot.json'), '{}');
      const env = { HOME: tempDir };
      expect(resolveConfigPath(env)).toBe(
        join(legacyDir, 'clawdbot.json'),
      );
    });

    it('returns default fallback when no config files exist', () => {
      const env = { HOME: tempDir };
      const result = resolveConfigPath(env);
      expect(result).toBe(join(tempDir, '.openclaw', 'openclaw.json'));
    });
  });

  // ─── resolveWorkspacePath ─────────────────────────────────────────
  describe('resolveWorkspacePath', () => {
    it('returns $STATE_DIR/workspace-{agentId}/', () => {
      const env = { OPENCLAW_STATE_DIR: '/state' };
      expect(resolveWorkspacePath('my-agent', env)).toBe(
        '/state/workspace-my-agent',
      );
    });
  });

  // ─── resolveReefStateDir ──────────────────────────────────────────
  describe('resolveReefStateDir', () => {
    it('returns $STATE_DIR/.reef/', () => {
      const env = { OPENCLAW_STATE_DIR: '/state' };
      expect(resolveReefStateDir(env)).toBe('/state/.reef');
    });
  });

  // ─── resolveGatewayUrl ────────────────────────────────────────────
  describe('resolveGatewayUrl', () => {
    it('returns ws://127.0.0.1:18789 by default', () => {
      expect(resolveGatewayUrl({}, {})).toBe('ws://127.0.0.1:18789');
    });

    it('uses custom port from config', () => {
      const config = { gateway: { port: 9999 } };
      expect(resolveGatewayUrl(config, {})).toBe('ws://127.0.0.1:9999');
    });

    it('uses TLS when enabled', () => {
      const config = { gateway: { tls: { enabled: true } } };
      expect(resolveGatewayUrl(config, {})).toBe('wss://127.0.0.1:18789');
    });

    it('uses port from env OPENCLAW_GATEWAY_PORT', () => {
      const env = { OPENCLAW_GATEWAY_PORT: '7777' };
      expect(resolveGatewayUrl({}, env)).toBe('ws://127.0.0.1:7777');
    });

    it('config port takes precedence over env port', () => {
      const config = { gateway: { port: 5555 } };
      const env = { OPENCLAW_GATEWAY_PORT: '7777' };
      expect(resolveGatewayUrl(config, env)).toBe('ws://127.0.0.1:5555');
    });
  });

  // ─── validateAgentId ──────────────────────────────────────────────
  describe('validateAgentId', () => {
    it('accepts valid IDs', () => {
      expect(validateAgentId('my-agent')).toEqual({
        valid: true,
        normalized: 'my-agent',
      });
      expect(validateAgentId('agent123')).toEqual({
        valid: true,
        normalized: 'agent123',
      });
      expect(validateAgentId('a')).toEqual({
        valid: true,
        normalized: 'a',
      });
      expect(validateAgentId('my_agent')).toEqual({
        valid: true,
        normalized: 'my_agent',
      });
    });

    it('rejects dots', () => {
      const result = validateAgentId('my.agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('dots');
    });

    it('rejects IDs longer than 64 characters', () => {
      const longId = 'a'.repeat(65);
      const result = validateAgentId(longId);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('64');
    });

    it('rejects invalid patterns', () => {
      expect(validateAgentId('-bad-start').valid).toBe(false);
      expect(validateAgentId('has spaces').valid).toBe(false);
      expect(validateAgentId('').valid).toBe(false);
      expect(validateAgentId('_leading-underscore').valid).toBe(false);
    });

    it('normalizes to lowercase', () => {
      const result = validateAgentId('MyAgent');
      expect(result.normalized).toBe('myagent');
    });
  });

  // ─── validateAgentIds ─────────────────────────────────────────────
  describe('validateAgentIds', () => {
    it('validates all slugs at once', () => {
      const result = validateAgentIds(['worker', 'manager'], 'ns');
      expect(result.valid).toBe(true);
      expect(result.ids.get('worker')).toBe('ns-worker');
      expect(result.ids.get('manager')).toBe('ns-manager');
      expect(result.errors).toHaveLength(0);
    });

    it('detects collisions', () => {
      // 'a-b' and 'a_b' with namespace 'ns' would not collide,
      // but two slugs that produce the same normalized ID would.
      // e.g., with namespace 'ns', slugs 'A' and 'a' both become 'ns-a'
      const result = validateAgentIds(['worker', 'worker'], 'ns');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('same normalized ID');
    });

    it('reports invalid slug errors', () => {
      const result = validateAgentIds(['valid', 'bad.slug'], 'ns');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
