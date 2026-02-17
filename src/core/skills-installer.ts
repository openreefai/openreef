import { GatewayClient, resolveGatewayAuth } from './gateway-client.js';
import { resolveGatewayUrl } from './openclaw-paths.js';
import { readConfig } from './config-patcher.js';

export interface SkillInstallResult {
  name: string;
  status: 'installed' | 'already_installed' | 'skipped' | 'failed';
  error?: string;
}

export interface GatewayOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: Record<string, unknown>;
}

/**
 * Check installed skills via skills.status RPC.
 * Returns a set of skill names that are currently available.
 */
export async function getInstalledSkills(
  gatewayOptions?: GatewayOptions,
): Promise<Set<string>> {
  const installed = new Set<string>();

  try {
    const config = gatewayOptions?.config ?? (await readConfig()).config;
    const gwUrl =
      gatewayOptions?.gatewayUrl ?? resolveGatewayUrl(config, process.env);
    const gwAuth = resolveGatewayAuth({
      gatewayUrl: gatewayOptions?.gatewayUrl,
      gatewayToken: gatewayOptions?.gatewayToken,
      gatewayPassword: gatewayOptions?.gatewayPassword,
      config,
    });
    const gw = new GatewayClient({ url: gwUrl, ...gwAuth });
    await gw.connect();

    try {
      const status = await gw.call<Record<string, unknown>>(
        'skills.status',
        {},
      );

      // Parse the response — the exact shape is not fully documented,
      // so we handle multiple possible structures defensively.
      if (status && typeof status === 'object') {
        // Check for a skills array or object
        const skills = (status as Record<string, unknown>).skills;
        if (Array.isArray(skills)) {
          for (const skill of skills) {
            if (typeof skill === 'string') {
              installed.add(skill);
            } else if (skill && typeof skill === 'object') {
              const s = skill as Record<string, unknown>;
              const name = s.name ?? s.id ?? s.skill;
              if (typeof name === 'string') {
                installed.add(name);
              }
            }
          }
        } else if (skills && typeof skills === 'object') {
          // Object keyed by skill name
          for (const name of Object.keys(skills as Record<string, unknown>)) {
            installed.add(name);
          }
        }
      }
    } catch {
      // skills.status RPC failed — return empty set
    }

    gw.close();
  } catch {
    // Gateway not reachable — return empty set
  }

  return installed;
}

/**
 * Install skills that are declared in the manifest but not yet installed.
 * Called after lockfile integrity checks have passed.
 *
 * Note: The skills.install RPC does not support version constraints.
 * Version pinning is enforced at the lockfile level, not at install time.
 */
export async function installSkills(
  skills: Record<string, string>, // name -> version range from manifest
  gatewayOptions?: GatewayOptions,
): Promise<SkillInstallResult[]> {
  const results: SkillInstallResult[] = [];
  const skillNames = Object.keys(skills);

  if (skillNames.length === 0) return results;

  let gw: GatewayClient | null = null;

  try {
    const config = gatewayOptions?.config ?? (await readConfig()).config;
    const gwUrl =
      gatewayOptions?.gatewayUrl ?? resolveGatewayUrl(config, process.env);
    const gwAuth = resolveGatewayAuth({
      gatewayUrl: gatewayOptions?.gatewayUrl,
      gatewayToken: gatewayOptions?.gatewayToken,
      gatewayPassword: gatewayOptions?.gatewayPassword,
      config,
    });
    gw = new GatewayClient({ url: gwUrl, ...gwAuth });
    await gw.connect();
  } catch {
    // Gateway unavailable — skip all skills
    for (const name of skillNames) {
      results.push({ name, status: 'skipped', error: 'Gateway unavailable' });
    }
    return results;
  }

  try {
    // Check which skills are already installed
    const installedNames = new Set<string>();
    try {
      const status = await gw.call<Record<string, unknown>>(
        'skills.status',
        {},
      );

      if (status && typeof status === 'object') {
        const skillsData = (status as Record<string, unknown>).skills;
        if (Array.isArray(skillsData)) {
          for (const skill of skillsData) {
            if (typeof skill === 'string') {
              installedNames.add(skill);
            } else if (skill && typeof skill === 'object') {
              const s = skill as Record<string, unknown>;
              const name = s.name ?? s.id ?? s.skill;
              if (typeof name === 'string') {
                installedNames.add(name);
              }
            }
          }
        } else if (skillsData && typeof skillsData === 'object') {
          for (const name of Object.keys(
            skillsData as Record<string, unknown>,
          )) {
            installedNames.add(name);
          }
        }
      }
    } catch {
      // skills.status failed — proceed to install all (idempotent)
    }

    // Install each missing skill
    for (const name of skillNames) {
      if (installedNames.has(name)) {
        results.push({ name, status: 'already_installed' });
        continue;
      }

      try {
        // Note: skills.install RPC does not support version pinning.
        // Lockfile enforcement handles version/integrity verification separately.
        await gw.call('skills.install', {
          name,
          installId: `reef-${name}`,
          timeoutMs: 30000,
        });
        results.push({ name, status: 'installed' });
      } catch (err) {
        results.push({
          name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    gw.close();
  }

  return results;
}
