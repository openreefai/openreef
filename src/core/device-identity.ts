import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveStateDir } from './openclaw-paths.js';

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface DeviceAuthEntry {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
}

/**
 * Derive deviceId as SHA-256 hex of the raw 32-byte Ed25519 public key.
 */
function deriveDeviceId(publicKeyPem: string): string {
  const pubDer = crypto.createPublicKey(publicKeyPem).export({
    type: 'spki',
    format: 'der',
  });
  const rawPubKey = pubDer.subarray(pubDer.length - 32);
  return crypto.createHash('sha256').update(rawPubKey).digest('hex');
}

export function loadOrCreateDeviceIdentity(
  env?: NodeJS.ProcessEnv,
): DeviceIdentity {
  const stateDir = resolveStateDir(env);
  const identityDir = join(stateDir, 'identity');
  const filePath = join(identityDir, 'device.json');

  if (existsSync(filePath)) {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Revalidate deviceId: recompute from stored public key to detect
    // stale entries written with old derivation (e.g., full SPKI DER hash)
    const correctId = deriveDeviceId(data.publicKeyPem);
    if (data.deviceId !== correctId) {
      data.deviceId = correctId;
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      chmodSync(filePath, 0o600);
    }

    return {
      deviceId: correctId,
      publicKeyPem: data.publicKeyPem,
      privateKeyPem: data.privateKeyPem,
    };
  }

  // Generate new Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const deviceId = deriveDeviceId(publicKey);

  const identity: DeviceIdentity = {
    deviceId,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  };

  mkdirSync(identityDir, { recursive: true });
  const fileData = {
    version: 1,
    deviceId,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    createdAtMs: Date.now(),
  };
  writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf-8');
  chmodSync(filePath, 0o600);

  return identity;
}

export function signDevicePayload(
  privateKeyPem: string,
  payload: string,
): string {
  const sig = crypto.sign(null, Buffer.from(payload), privateKeyPem);
  return sig.toString('base64url');
}

export function publicKeyRawBase64Url(publicKeyPem: string): string {
  const pubDer = crypto
    .createPublicKey(publicKeyPem)
    .export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI DER has 12-byte prefix before the 32-byte raw key
  const raw = pubDer.subarray(pubDer.length - 32);
  return Buffer.from(raw).toString('base64url');
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce?: string;
}): string {
  const scopeStr = params.scopes.join(',');
  const tokenStr = params.token ?? '';

  if (params.nonce) {
    return `v2|${params.deviceId}|${params.clientId}|${params.clientMode}|${params.role}|${scopeStr}|${params.signedAtMs}|${tokenStr}|${params.nonce}`;
  }

  return `v1|${params.deviceId}|${params.clientId}|${params.clientMode}|${params.role}|${scopeStr}|${params.signedAtMs}|${tokenStr}`;
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const stateDir = resolveStateDir(params.env);
  const filePath = join(stateDir, 'identity', 'device-auth.json');

  if (!existsSync(filePath)) return null;

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Verify deviceId matches — tokens issued for a different device are invalid
    if (data.deviceId && data.deviceId !== params.deviceId) return null;
    const entry = data?.tokens?.[params.role];
    if (!entry) return null;
    return entry as DeviceAuthEntry;
  } catch {
    return null;
  }
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const stateDir = resolveStateDir(params.env);
  const identityDir = join(stateDir, 'identity');
  const filePath = join(identityDir, 'device-auth.json');

  let data: Record<string, unknown> = {
    version: 1,
    deviceId: params.deviceId,
    tokens: {},
  };
  if (existsSync(filePath)) {
    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf-8'));
      // If deviceId changed, reset tokens (old tokens are invalid)
      if (existing.deviceId === params.deviceId) {
        data = existing;
        // Ensure top-level fields are present
        data.version = data.version ?? 1;
        data.deviceId = params.deviceId;
        if (!data.tokens) data.tokens = {};
      }
    } catch {
      // Corrupt file — overwrite with fresh structure
    }
  }

  const tokens = data.tokens as Record<string, unknown>;
  tokens[params.role] = {
    token: params.token,
    role: params.role,
    scopes: params.scopes,
    updatedAtMs: Date.now(),
  } satisfies DeviceAuthEntry;

  mkdirSync(identityDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  chmodSync(filePath, 0o600);
}
