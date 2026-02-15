import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as crypto from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64Url,
  buildDeviceAuthPayload,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from '../../src/core/device-identity.js';

let tempDir: string;
let env: NodeJS.ProcessEnv;

describe('device-identity', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-identity-test-'));
    env = { OPENCLAW_STATE_DIR: tempDir };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── loadOrCreateDeviceIdentity ───────────────────────────────────
  describe('loadOrCreateDeviceIdentity', () => {
    it('creates keypair on first call', () => {
      const identity = loadOrCreateDeviceIdentity(env);

      expect(identity.deviceId).toBeTruthy();
      expect(identity.publicKeyPem).toBeTruthy();
      expect(identity.privateKeyPem).toBeTruthy();
    });

    it('deviceId is SHA-256 hex (64 hex chars)', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('publicKeyPem is a valid PEM string', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      expect(identity.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
      expect(identity.publicKeyPem).toContain('-----END PUBLIC KEY-----');
    });

    it('privateKeyPem is a valid PEM string', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      expect(identity.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(identity.privateKeyPem).toContain('-----END PRIVATE KEY-----');
    });

    it('reuses identity on second call', () => {
      const first = loadOrCreateDeviceIdentity(env);
      const second = loadOrCreateDeviceIdentity(env);

      expect(second.deviceId).toBe(first.deviceId);
      expect(second.publicKeyPem).toBe(first.publicKeyPem);
      expect(second.privateKeyPem).toBe(first.privateKeyPem);
    });

    it('repairs stale deviceId from old SPKI DER derivation', () => {
      // Create an identity first
      const identity = loadOrCreateDeviceIdentity(env);
      const correctId = identity.deviceId;

      // Corrupt the deviceId in the file (simulate old SPKI DER hash)
      const filePath = join(tempDir, 'identity', 'device.json');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      data.deviceId = 'stale-wrong-id-from-old-derivation';
      writeFileSync(filePath, JSON.stringify(data, null, 2));

      // Reload — should repair
      const reloaded = loadOrCreateDeviceIdentity(env);
      expect(reloaded.deviceId).toBe(correctId);
      expect(reloaded.deviceId).not.toBe('stale-wrong-id-from-old-derivation');

      // File should also be updated
      const repaired = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(repaired.deviceId).toBe(correctId);
    });
  });

  // ─── loadDeviceAuthToken / storeDeviceAuthToken ─────────────────
  describe('device auth token storage', () => {
    it('stores and loads auth token by role and deviceId', () => {
      const deviceId = 'test-device-id';
      storeDeviceAuthToken({
        deviceId,
        role: 'operator',
        token: 'my-token',
        scopes: ['operator.admin'],
        env,
      });

      const loaded = loadDeviceAuthToken({
        deviceId,
        role: 'operator',
        env,
      });
      expect(loaded).not.toBeNull();
      expect(loaded!.token).toBe('my-token');
      expect(loaded!.scopes).toEqual(['operator.admin']);
    });

    it('returns null for wrong deviceId', () => {
      storeDeviceAuthToken({
        deviceId: 'device-a',
        role: 'operator',
        token: 'token-a',
        scopes: ['operator.admin'],
        env,
      });

      const loaded = loadDeviceAuthToken({
        deviceId: 'device-b',
        role: 'operator',
        env,
      });
      expect(loaded).toBeNull();
    });

    it('resets tokens when deviceId changes', () => {
      storeDeviceAuthToken({
        deviceId: 'old-device',
        role: 'operator',
        token: 'old-token',
        scopes: ['operator.admin'],
        env,
      });

      // Store with new deviceId — should reset
      storeDeviceAuthToken({
        deviceId: 'new-device',
        role: 'operator',
        token: 'new-token',
        scopes: ['operator.admin'],
        env,
      });

      // Old device's token should be gone
      const oldLoaded = loadDeviceAuthToken({
        deviceId: 'old-device',
        role: 'operator',
        env,
      });
      expect(oldLoaded).toBeNull();

      // New device's token should be present
      const newLoaded = loadDeviceAuthToken({
        deviceId: 'new-device',
        role: 'operator',
        env,
      });
      expect(newLoaded).not.toBeNull();
      expect(newLoaded!.token).toBe('new-token');
    });

    it('stores version and deviceId in file', () => {
      storeDeviceAuthToken({
        deviceId: 'test-id',
        role: 'operator',
        token: 'tok',
        scopes: [],
        env,
      });

      const filePath = join(tempDir, 'identity', 'device-auth.json');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(data.version).toBe(1);
      expect(data.deviceId).toBe('test-id');
    });
  });

  // ─── signDevicePayload ────────────────────────────────────────────
  describe('signDevicePayload', () => {
    it('returns a base64url string', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      const signature = signDevicePayload(identity.privateKeyPem, 'test payload');

      expect(typeof signature).toBe('string');
      // base64url: no +, /, or = characters
      expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('signature is verifiable with the public key', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      const payload = 'test payload for verification';
      const signature = signDevicePayload(identity.privateKeyPem, payload);

      const sigBuffer = Buffer.from(signature, 'base64url');
      const isValid = crypto.verify(
        null,
        Buffer.from(payload),
        identity.publicKeyPem,
        sigBuffer,
      );
      expect(isValid).toBe(true);
    });

    it('signature fails verification with wrong payload', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      const signature = signDevicePayload(identity.privateKeyPem, 'original');

      const sigBuffer = Buffer.from(signature, 'base64url');
      const isValid = crypto.verify(
        null,
        Buffer.from('tampered'),
        identity.publicKeyPem,
        sigBuffer,
      );
      expect(isValid).toBe(false);
    });
  });

  // ─── publicKeyRawBase64Url ────────────────────────────────────────
  describe('publicKeyRawBase64Url', () => {
    it('returns 32-byte raw key as base64url (43 chars)', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      const raw = publicKeyRawBase64Url(identity.publicKeyPem);

      expect(typeof raw).toBe('string');
      // 32 bytes in base64url = ceil(32 * 4 / 3) = 43 chars (no padding)
      expect(raw.length).toBe(43);
      // base64url format
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('decodes back to 32 bytes', () => {
      const identity = loadOrCreateDeviceIdentity(env);
      const raw = publicKeyRawBase64Url(identity.publicKeyPem);
      const decoded = Buffer.from(raw, 'base64url');
      expect(decoded.length).toBe(32);
    });
  });

  // ─── buildDeviceAuthPayload ───────────────────────────────────────
  describe('buildDeviceAuthPayload', () => {
    const baseParams = {
      deviceId: 'abc123',
      clientId: 'cli',
      clientMode: 'cli',
      role: 'operator',
      scopes: ['admin', 'approvals'],
      signedAtMs: 1700000000000,
      token: null as string | null,
    };

    it('v1 format without nonce (pipe-delimited)', () => {
      const result = buildDeviceAuthPayload(baseParams);
      expect(result).toBe(
        'v1|abc123|cli|cli|operator|admin,approvals|1700000000000|',
      );
    });

    it('v1 format with token', () => {
      const result = buildDeviceAuthPayload({
        ...baseParams,
        token: 'my-token',
      });
      expect(result).toBe(
        'v1|abc123|cli|cli|operator|admin,approvals|1700000000000|my-token',
      );
    });

    it('v2 format with nonce', () => {
      const result = buildDeviceAuthPayload({
        ...baseParams,
        nonce: 'test-nonce',
      });
      expect(result).toBe(
        'v2|abc123|cli|cli|operator|admin,approvals|1700000000000||test-nonce',
      );
    });

    it('v2 format with nonce and token', () => {
      const result = buildDeviceAuthPayload({
        ...baseParams,
        token: 'my-token',
        nonce: 'test-nonce',
      });
      expect(result).toBe(
        'v2|abc123|cli|cli|operator|admin,approvals|1700000000000|my-token|test-nonce',
      );
    });
  });
});
