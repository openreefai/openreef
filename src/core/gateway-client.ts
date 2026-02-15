import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64Url,
  buildDeviceAuthPayload,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from './device-identity.js';

const PROTOCOL_VERSION = 3;
const CLIENT_ID = 'cli';
const CLIENT_MODE = 'cli';
const ROLE = 'operator';
const SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing'];

export interface CronSchedule {
  kind: 'cron' | 'every' | 'at';
  expr?: string;
  tz?: string;
  everyMs?: number;
  at?: string;
}

export interface CronPayload {
  kind: 'agentTurn' | 'systemEvent';
  message?: string;
  text?: string;
  model?: string;
}

export interface CronDelivery {
  channel?: string;
}

export interface CronAddParams {
  name: string;
  schedule: CronSchedule;
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'next-heartbeat' | 'now';
  payload: CronPayload;
  agentId?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  delivery?: CronDelivery;
}

export interface CronJobPatch {
  name?: string;
  schedule?: CronSchedule;
  sessionTarget?: 'main' | 'isolated';
  wakeMode?: 'next-heartbeat' | 'now';
  payload?: CronPayload;
  agentId?: string;
  description?: string;
  enabled?: boolean;
  delivery?: CronDelivery;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  sessionTarget: string;
  wakeMode: string;
  payload: CronPayload;
  agentId?: string;
  enabled: boolean;
  state: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface GatewayClientOptions {
  url: string;
  token?: string;
  password?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Skip loading stored device auth token. Set true for remote URL overrides. */
  skipStoredAuth?: boolean;
}

/**
 * Resolve Gateway auth credentials from multiple sources.
 * If gatewayUrl is explicitly provided (override), ONLY explicit --gateway-token
 * or --gateway-password satisfy auth — env/config fallbacks are NOT accepted.
 * For local (non-overridden) URLs: explicit CLI → env vars → config file values.
 */
export function resolveGatewayAuth(opts: {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string; skipStoredAuth?: boolean } {
  // If URL was explicitly overridden, require explicit CLI auth (no env/config fallback)
  if (opts.gatewayUrl) {
    if (!opts.gatewayToken && !opts.gatewayPassword) {
      throw new Error(
        'Gateway URL override requires --gateway-token or --gateway-password.',
      );
    }
    return {
      token: opts.gatewayToken ?? undefined,
      password: opts.gatewayPassword ?? undefined,
      skipStoredAuth: true,
    };
  }

  // Local/default URL: full resolution chain
  const e = opts.env ?? process.env;
  const gw = (opts.config?.gateway ?? {}) as Record<string, unknown>;
  const auth = (gw.auth ?? {}) as Record<string, unknown>;

  const token =
    opts.gatewayToken ??
    e.OPENCLAW_GATEWAY_TOKEN ??
    (auth.token as string | undefined);

  const password =
    opts.gatewayPassword ??
    e.OPENCLAW_GATEWAY_PASSWORD ??
    (auth.password as string | undefined);

  return {
    token: token ?? undefined,
    password: password ?? undefined,
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connected = false;
  private options: GatewayClientOptions;
  private timeoutMs: number;

  constructor(options: GatewayClientOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async connect(): Promise<void> {
    const identity = loadOrCreateDeviceIdentity(this.options.env);

    // Load stored device auth token as fallback (only for local URLs)
    const storedAuth = this.options.skipStoredAuth
      ? null
      : loadDeviceAuthToken({
          deviceId: identity.deviceId,
          role: ROLE,
          env: this.options.env,
        });

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;

      let challengeNonce: string | undefined;
      let connectSent = false;
      let connectTimer: ReturnType<typeof setTimeout>;

      const sendConnect = (nonce?: string) => {
        if (connectSent) return;
        connectSent = true;

        const signedAt = Date.now();
        const authToken =
          this.options.token ?? storedAuth?.token ?? undefined;

        const authPayload = buildDeviceAuthPayload({
          deviceId: identity.deviceId,
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role: ROLE,
          scopes: SCOPES,
          signedAtMs: signedAt,
          token: authToken ?? null,
          nonce,
        });

        const signature = signDevicePayload(
          identity.privateKeyPem,
          authPayload,
        );

        const connectParams: Record<string, unknown> = {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: CLIENT_ID,
            version: '0.2.0',
            platform: process.platform,
            mode: CLIENT_MODE,
          },
          role: ROLE,
          scopes: SCOPES,
          device: {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
            signature,
            signedAt: signedAt,
            ...(nonce ? { nonce } : {}),
          },
        };

        // Add auth if available
        const auth: Record<string, unknown> = {};
        if (authToken) auth.token = authToken;
        if (this.options.password) auth.password = this.options.password;
        if (Object.keys(auth).length > 0) {
          connectParams.auth = auth;
        }

        const reqId = randomUUID();
        const frame = {
          type: 'req',
          id: reqId,
          method: 'connect',
          params: connectParams,
        };

        ws.send(JSON.stringify(frame));

        // Wait for connect response
        const timer = setTimeout(() => {
          this.pending.delete(reqId);
          reject(new Error('Gateway connect handshake timed out'));
        }, this.timeoutMs);

        this.pending.set(reqId, {
          resolve: (payload: unknown) => {
            this.connected = true;
            // Store device token if returned
            const p = payload as Record<string, unknown> | null;
            const authResult = p?.auth as Record<string, unknown> | undefined;
            if (authResult?.deviceToken) {
              storeDeviceAuthToken({
                deviceId: identity.deviceId,
                role: ROLE,
                token: authResult.deviceToken as string,
                scopes: SCOPES,
                env: this.options.env,
              });
            }
            resolve();
          },
          reject,
          timer,
        });
      };

      ws.on('open', () => {
        // Queue connect with 750ms delay — allows challenge to arrive first
        connectTimer = setTimeout(() => sendConnect(), 750);
      });

      ws.on('message', (data: WebSocket.Data) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }

        // Handle connect.challenge event
        if (
          frame.type === 'event' &&
          frame.event === 'connect.challenge'
        ) {
          const payload = frame.payload as Record<string, unknown>;
          challengeNonce = payload.nonce as string;
          clearTimeout(connectTimer);
          sendConnect(challengeNonce);
          return;
        }

        // Handle response frames
        if (frame.type === 'res') {
          const id = frame.id as string;
          const pending = this.pending.get(id);
          if (!pending) return;

          clearTimeout(pending.timer);
          this.pending.delete(id);

          if (frame.ok) {
            pending.resolve(frame.payload);
          } else {
            const err = frame.error as Record<string, unknown> | undefined;
            pending.reject(
              new Error(
                `Gateway error: ${err?.code ?? 'unknown'} — ${err?.message ?? 'no message'}`,
              ),
            );
          }
        }
      });

      ws.on('error', (err) => {
        reject(
          new Error(`Gateway connection failed: ${err.message}`),
        );
      });

      ws.on('close', () => {
        this.connected = false;
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Gateway connection closed'));
          this.pending.delete(id);
        }
      });
    });
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error('Gateway not connected. Call connect() first.');
    }

    const id = randomUUID();
    const frame = { type: 'req', id, method, params: params ?? {} };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway call "${method}" timed out`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  async cronAdd(params: CronAddParams): Promise<{ id: string }> {
    return this.call<{ id: string }>('cron.add', params);
  }

  async cronRemove(id: string): Promise<void> {
    await this.call<void>('cron.remove', { id });
  }

  async cronUpdate(id: string, patch: CronJobPatch): Promise<void> {
    await this.call<void>('cron.update', { id, patch });
  }

  async cronList(options?: {
    includeDisabled?: boolean;
  }): Promise<CronJob[]> {
    const result = await this.call<{ jobs: CronJob[] }>(
      'cron.list',
      options ?? {},
    );
    return result.jobs ?? [];
  }
}
