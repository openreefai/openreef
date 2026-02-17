import { spawnSync } from 'node:child_process';
import { satisfiesRange } from '../utils/semver.js';
import { GatewayClient, resolveGatewayAuth } from './gateway-client.js';
import { resolveGatewayUrl, resolveConfigPath } from './openclaw-paths.js';
import { readConfig } from './config-patcher.js';

export interface CompatCheckResult {
  compatible: boolean;
  openclawVersion: string | null;
  source: 'gateway' | 'cli' | 'unknown';
  requiredRange: string;
  error?: string;
}

/**
 * Resolve the running OpenClaw version using deterministic source order:
 * 1. Gateway-reported version (via status RPC if available)
 * 2. Local `openclaw --version` CLI output
 * 3. null (unable to determine)
 */
async function resolveOpenClawVersion(
  gatewayOptions?: {
    gatewayUrl?: string;
    gatewayToken?: string;
    gatewayPassword?: string;
    config?: Record<string, unknown>;
  },
): Promise<{ version: string; source: 'gateway' | 'cli' } | null> {
  // Try gateway first
  if (gatewayOptions) {
    try {
      const config = gatewayOptions.config ?? (await readConfig()).config;
      const gwUrl = gatewayOptions.gatewayUrl ?? resolveGatewayUrl(config, process.env);
      const gwAuth = resolveGatewayAuth({
        gatewayUrl: gatewayOptions.gatewayUrl,
        gatewayToken: gatewayOptions.gatewayToken,
        gatewayPassword: gatewayOptions.gatewayPassword,
        config,
      });
      const gw = new GatewayClient({ url: gwUrl, ...gwAuth });
      await gw.connect();
      try {
        const status = await gw.call('gateway.status', {});
        gw.close();
        const version = (status as Record<string, unknown>)?.version;
        if (typeof version === 'string' && version.length > 0) {
          return { version, source: 'gateway' };
        }
      } catch {
        gw.close();
      }
    } catch {
      // Gateway not reachable — fall through to CLI
    }
  }

  // Try local CLI
  try {
    const result = spawnSync('openclaw', ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout) {
      const version = result.stdout.trim().replace(/^v/i, '');
      if (version.length > 0) {
        return { version, source: 'cli' };
      }
    }
  } catch {
    // CLI not available
  }

  return null;
}

/**
 * Check that the running OpenClaw version satisfies the manifest's
 * compatibility.openclaw range. Returns a result object.
 */
export async function checkOpenClawCompatibility(
  requiredRange: string,
  gatewayOptions?: {
    gatewayUrl?: string;
    gatewayToken?: string;
    gatewayPassword?: string;
    config?: Record<string, unknown>;
  },
): Promise<CompatCheckResult> {
  const resolved = await resolveOpenClawVersion(gatewayOptions);

  if (!resolved) {
    return {
      compatible: false,
      openclawVersion: null,
      source: 'unknown',
      requiredRange,
      error: 'Unable to determine OpenClaw version. Use --skip-compat to override.',
    };
  }

  const compatible = satisfiesRange(resolved.version, requiredRange);

  return {
    compatible,
    openclawVersion: resolved.version,
    source: resolved.source,
    requiredRange,
    error: compatible
      ? undefined
      : `OpenClaw ${resolved.version} does not satisfy required range "${requiredRange}".`,
  };
}
