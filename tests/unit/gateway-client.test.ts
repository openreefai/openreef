import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayClient, resolveGatewayAuth } from '../../src/core/gateway-client.js';
import { createMockGateway, type MockGateway } from '../helpers/mock-gateway.js';

let tempDir: string;
let env: NodeJS.ProcessEnv;
let mockGw: MockGateway | null = null;
let client: GatewayClient | null = null;

describe('gateway-client', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reef-gw-test-'));
    env = { OPENCLAW_STATE_DIR: tempDir };
    mockGw = await createMockGateway();
  });

  afterEach(async () => {
    if (client) {
      client.close();
      client = null;
    }
    if (mockGw) {
      await new Promise<void>((resolve) => {
        mockGw!.wss.close(() => resolve());
      });
      mockGw = null;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('connect handshake succeeds with mock server', async () => {
    if (!mockGw) return; // Skip in sandboxed environments

    client = new GatewayClient({
      url: `ws://127.0.0.1:${mockGw.port}`,
      timeoutMs: 5000,
      env,
    });

    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('cronAdd returns job ID', async () => {
    if (!mockGw) return;

    client = new GatewayClient({
      url: `ws://127.0.0.1:${mockGw.port}`,
      timeoutMs: 5000,
      env,
    });
    await client.connect();

    const result = await client.cronAdd({
      name: 'test-job',
      schedule: { kind: 'cron', expr: '*/5 * * * *' },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'hello' },
    });

    expect(result.id).toMatch(/^job-/);
  });

  it('cronRemove succeeds', async () => {
    if (!mockGw) return;

    client = new GatewayClient({
      url: `ws://127.0.0.1:${mockGw.port}`,
      timeoutMs: 5000,
      env,
    });
    await client.connect();

    await expect(client.cronRemove('mock-job-id')).resolves.toBeUndefined();
  });

  it('cronList returns empty array', async () => {
    if (!mockGw) return;

    client = new GatewayClient({
      url: `ws://127.0.0.1:${mockGw.port}`,
      timeoutMs: 5000,
      env,
    });
    await client.connect();

    const jobs = await client.cronList();
    expect(jobs).toEqual([]);
  });

  it('cronUpdate succeeds', async () => {
    if (!mockGw) return;

    client = new GatewayClient({
      url: `ws://127.0.0.1:${mockGw.port}`,
      timeoutMs: 5000,
      env,
    });
    await client.connect();

    await expect(
      client.cronUpdate('mock-job-id', { name: 'updated-job' }),
    ).resolves.toBeUndefined();
  });

  it('connection failure gives clear error', async () => {
    // Use a port that nothing is listening on
    client = new GatewayClient({
      url: 'ws://127.0.0.1:19999',
      timeoutMs: 3000,
      env,
    });

    await expect(client.connect()).rejects.toThrow('Gateway connection failed');
  });
});

describe('resolveGatewayAuth', () => {
  it('throws when gatewayUrl is set without explicit token or password', () => {
    expect(() =>
      resolveGatewayAuth({
        gatewayUrl: 'ws://remote:1234',
      }),
    ).toThrow('Gateway URL override requires --gateway-token or --gateway-password.');
  });

  it('throws even when env/config have tokens if gatewayUrl is set without CLI args', () => {
    expect(() =>
      resolveGatewayAuth({
        gatewayUrl: 'ws://remote:1234',
        config: { gateway: { auth: { token: 'config-token' } } },
        env: { OPENCLAW_GATEWAY_TOKEN: 'env-token' },
      }),
    ).toThrow('Gateway URL override requires --gateway-token or --gateway-password.');
  });

  it('accepts explicit gatewayToken with gatewayUrl', () => {
    const result = resolveGatewayAuth({
      gatewayUrl: 'ws://remote:1234',
      gatewayToken: 'explicit-token',
    });
    expect(result.token).toBe('explicit-token');
    expect(result.password).toBeUndefined();
  });

  it('accepts explicit gatewayPassword with gatewayUrl', () => {
    const result = resolveGatewayAuth({
      gatewayUrl: 'ws://remote:1234',
      gatewayPassword: 'explicit-pass',
    });
    expect(result.token).toBeUndefined();
    expect(result.password).toBe('explicit-pass');
  });

  it('resolves from env when no gatewayUrl override', () => {
    const result = resolveGatewayAuth({
      env: { OPENCLAW_GATEWAY_TOKEN: 'env-token' },
    });
    expect(result.token).toBe('env-token');
  });

  it('resolves from config when no gatewayUrl override', () => {
    const result = resolveGatewayAuth({
      config: { gateway: { auth: { password: 'config-pass' } } },
      env: {},
    });
    expect(result.password).toBe('config-pass');
  });

  it('explicit CLI opts take precedence over env/config for local URL', () => {
    const result = resolveGatewayAuth({
      gatewayToken: 'explicit',
      config: { gateway: { auth: { token: 'config-token' } } },
      env: { OPENCLAW_GATEWAY_TOKEN: 'env-token' },
    });
    expect(result.token).toBe('explicit');
  });
});
