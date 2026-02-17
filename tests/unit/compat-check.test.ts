import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track mock instances created by the GatewayClient constructor
let mockGwInstance: {
  connect: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

// Mock all external dependencies before importing the module under test
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('../../src/core/gateway-client.js', () => {
  return {
    GatewayClient: function GatewayClient() {
      return mockGwInstance;
    },
    resolveGatewayAuth: vi.fn(() => ({ token: 'test-token' })),
  };
});

vi.mock('../../src/core/openclaw-paths.js', () => ({
  resolveGatewayUrl: vi.fn(() => 'ws://localhost:9999'),
  resolveConfigPath: vi.fn(() => '/tmp/test-config.json'),
}));

vi.mock('../../src/core/config-patcher.js', () => ({
  readConfig: vi.fn(() =>
    Promise.resolve({ config: {}, raw: '', path: '/tmp/test-config.json' }),
  ),
}));

import { checkOpenClawCompatibility } from '../../src/core/compat-check.js';
import { spawnSync } from 'node:child_process';

const mockSpawnSync = vi.mocked(spawnSync);

describe('compat-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock instance for each test
    mockGwInstance = {
      connect: vi.fn().mockResolvedValue(undefined),
      call: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
    };
  });

  describe('when OpenClaw version satisfies the required range', () => {
    it('returns compatible: true via gateway', async () => {
      mockGwInstance.call.mockResolvedValue({ version: '0.3.0' });

      const result = await checkOpenClawCompatibility('>=0.2.0', {
        gatewayUrl: 'ws://localhost:9999',
        config: {},
      });

      expect(result.compatible).toBe(true);
      expect(result.openclawVersion).toBe('0.3.0');
      expect(result.source).toBe('gateway');
      expect(result.error).toBeUndefined();
    });

    it('returns compatible: true via CLI fallback', async () => {
      // No gateway options provided, falls through to CLI
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: 'v0.5.0\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      });

      const result = await checkOpenClawCompatibility('>=0.2.0');

      expect(result.compatible).toBe(true);
      expect(result.openclawVersion).toBe('0.5.0');
      expect(result.source).toBe('cli');
      expect(result.error).toBeUndefined();
    });
  });

  describe('when OpenClaw version does not satisfy the required range', () => {
    it('returns compatible: false with error message via gateway', async () => {
      mockGwInstance.call.mockResolvedValue({ version: '0.1.0' });

      const result = await checkOpenClawCompatibility('>=0.2.0', {
        gatewayUrl: 'ws://localhost:9999',
        config: {},
      });

      expect(result.compatible).toBe(false);
      expect(result.openclawVersion).toBe('0.1.0');
      expect(result.source).toBe('gateway');
      expect(result.error).toBe(
        'OpenClaw 0.1.0 does not satisfy required range ">=0.2.0".',
      );
    });

    it('returns compatible: false with error message via CLI', async () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: '0.1.5\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      });

      const result = await checkOpenClawCompatibility('>=0.2.0');

      expect(result.compatible).toBe(false);
      expect(result.openclawVersion).toBe('0.1.5');
      expect(result.source).toBe('cli');
      expect(result.error).toContain('does not satisfy required range');
    });
  });

  describe('when version cannot be determined', () => {
    it('returns compatible: false with "Unable to determine" error', async () => {
      // CLI fails
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'not found',
        pid: 0,
        output: [],
        signal: null,
      });

      // No gateway options — skip gateway attempt
      const result = await checkOpenClawCompatibility('>=0.2.0');

      expect(result.compatible).toBe(false);
      expect(result.openclawVersion).toBeNull();
      expect(result.source).toBe('unknown');
      expect(result.error).toContain('Unable to determine');
    });

    it('falls back to CLI when gateway connection fails', async () => {
      mockGwInstance.connect.mockRejectedValue(new Error('Connection refused'));

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: '0.3.0\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      });

      const result = await checkOpenClawCompatibility('>=0.2.0', {
        gatewayUrl: 'ws://localhost:9999',
        config: {},
      });

      expect(result.compatible).toBe(true);
      expect(result.openclawVersion).toBe('0.3.0');
      expect(result.source).toBe('cli');
    });

    it('returns unknown when both gateway and CLI fail', async () => {
      mockGwInstance.connect.mockRejectedValue(new Error('Connection refused'));

      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      });

      const result = await checkOpenClawCompatibility('>=0.2.0', {
        gatewayUrl: 'ws://localhost:9999',
        config: {},
      });

      expect(result.compatible).toBe(false);
      expect(result.openclawVersion).toBeNull();
      expect(result.source).toBe('unknown');
      expect(result.error).toContain('Unable to determine OpenClaw version');
    });
  });
});
