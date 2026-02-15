import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

export interface MockGateway {
  wss: WebSocketServer;
  port: number;
}

/**
 * Create a mock Gateway WebSocket server for tests.
 * Returns null if socket binding fails (e.g., EPERM in sandboxed environments).
 */
export function createMockGateway(): Promise<MockGateway | null> {
  return new Promise((resolve) => {
    let server: WebSocketServer;
    try {
      server = new WebSocketServer({ port: 0 }, () => {
        const port = (server.address() as { port: number }).port;

        server.on('connection', (ws: WebSocket) => {
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'connect.challenge',
              payload: { nonce: 'test-nonce', ts: Date.now() },
            }),
          );

          ws.on('message', (data: Buffer) => {
            let frame: Record<string, unknown>;
            try {
              frame = JSON.parse(data.toString());
            } catch {
              return;
            }

            const reqId = frame.id as string;
            const method = frame.method as string;

            switch (method) {
              case 'connect':
                ws.send(
                  JSON.stringify({
                    type: 'res',
                    id: reqId,
                    ok: true,
                    payload: {},
                  }),
                );
                break;
              case 'cron.add':
                ws.send(
                  JSON.stringify({
                    type: 'res',
                    id: reqId,
                    ok: true,
                    payload: { id: `job-${Date.now()}` },
                  }),
                );
                break;
              case 'cron.remove':
                ws.send(
                  JSON.stringify({
                    type: 'res',
                    id: reqId,
                    ok: true,
                    payload: {},
                  }),
                );
                break;
              case 'cron.list':
                ws.send(
                  JSON.stringify({
                    type: 'res',
                    id: reqId,
                    ok: true,
                    payload: { jobs: [] },
                  }),
                );
                break;
              case 'cron.update':
                ws.send(
                  JSON.stringify({
                    type: 'res',
                    id: reqId,
                    ok: true,
                    payload: {},
                  }),
                );
                break;
            }
          });
        });

        resolve({ wss: server, port });
      });
    } catch {
      resolve(null);
      return;
    }

    server.on('error', () => {
      resolve(null);
    });
  });
}
