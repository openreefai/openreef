import { mkdtemp, writeFile, mkdir, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logs } from '../../src/commands/logs.js';

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'reef-logs-test-'));
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = join(tempHome, 'openclaw.json');
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function writeState(
  namespace: string,
  name: string,
  agents: Record<string, { id: string; slug: string }>,
): Promise<void> {
  const reefDir = join(tempHome, '.reef');
  await mkdir(reefDir, { recursive: true });
  const agentStates: Record<string, unknown> = {};
  for (const [slug, agent] of Object.entries(agents)) {
    agentStates[slug] = {
      id: agent.id,
      slug: agent.slug,
      workspace: join(tempHome, `ws-${agent.id}`),
      files: [],
    };
  }
  await writeFile(
    join(reefDir, `${namespace}--${name}.state.json`),
    JSON.stringify({
      name,
      version: '1.0.0',
      namespace,
      installedAt: '2025-01-01T00:00:00.000Z',
      agents: agentStates,
      bindings: [],
      cronJobs: [],
      variables: {},
      fileHashes: {},
    }),
  );
}

async function writeSessionLog(
  agentId: string,
  sessionName: string,
  lines: string[],
): Promise<void> {
  const sessionDir = join(tempHome, 'agents', agentId, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, sessionName), lines.join('\n') + '\n');
}

function captureConsole(): {
  logs: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(' '));
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

describe('reef logs', () => {
  it('shows logs for a valid formation with agent sessions', async () => {
    await writeState('ns', 'myapp', {
      triage: { id: 'ns-triage', slug: 'triage' },
    });
    await writeSessionLog('ns-triage', 'session-001.jsonl', [
      JSON.stringify({ ts: '2025-01-01T10:00:00Z', message: 'Hello world' }),
      JSON.stringify({ ts: '2025-01-01T10:01:00Z', message: 'Second line' }),
    ]);

    const cap = captureConsole();
    try {
      await logs('ns/myapp', { lines: 50 });
    } finally {
      cap.restore();
    }

    const output = cap.logs.join('\n');
    expect(output).toContain('Hello world');
    expect(output).toContain('Second line');
  });

  it('filters by --agent slug', async () => {
    await writeState('ns', 'myapp', {
      triage: { id: 'ns-triage', slug: 'triage' },
      worker: { id: 'ns-worker', slug: 'worker' },
    });
    await writeSessionLog('ns-triage', 'session-001.jsonl', [
      JSON.stringify({ ts: '2025-01-01T10:00:00Z', message: 'Triage log' }),
    ]);
    await writeSessionLog('ns-worker', 'session-001.jsonl', [
      JSON.stringify({ ts: '2025-01-01T10:00:00Z', message: 'Worker log' }),
    ]);

    const cap = captureConsole();
    try {
      await logs('ns/myapp', { agent: 'triage', lines: 50 });
    } finally {
      cap.restore();
    }

    const output = cap.logs.join('\n');
    expect(output).toContain('Triage log');
    expect(output).not.toContain('Worker log');
  });

  it('limits output with --lines', async () => {
    await writeState('ns', 'myapp', {
      triage: { id: 'ns-triage', slug: 'triage' },
    });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ ts: `2025-01-01T10:${String(i).padStart(2, '0')}:00Z`, message: `Line ${i}` }));
    }
    await writeSessionLog('ns-triage', 'session-001.jsonl', lines);

    const cap = captureConsole();
    try {
      await logs('ns/myapp', { lines: 5 });
    } finally {
      cap.restore();
    }

    const output = cap.logs.join('\n');
    // Should only show the last 5 lines
    expect(output).toContain('Line 15');
    expect(output).toContain('Line 19');
    expect(output).not.toContain('Line 0');
  });

  it('reads from --path directly', async () => {
    const logFile = join(tempHome, 'direct.jsonl');
    await writeFile(
      logFile,
      [
        JSON.stringify({ message: 'Direct line 1' }),
        JSON.stringify({ message: 'Direct line 2' }),
      ].join('\n') + '\n',
    );

    const cap = captureConsole();
    try {
      // identifier is ignored when --path is provided
      await logs('ignored', { path: logFile, lines: 50 });
    } finally {
      cap.restore();
    }

    const output = cap.logs.join('\n');
    expect(output).toContain('Direct line 1');
    expect(output).toContain('Direct line 2');
  });

  it('errors when --path points to non-existent file', async () => {
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await logs('ignored', { path: join(tempHome, 'nonexistent.jsonl') });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = cap.errors.join('\n');
    expect(errorOutput).toContain('not found');

    mockExit.mockRestore();
  });

  it('errors for non-existent formation', async () => {
    await mkdir(join(tempHome, '.reef'), { recursive: true });

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await logs('ns/nonexistent', { lines: 50 });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = cap.errors.join('\n');
    expect(errorOutput).toContain('not found');

    mockExit.mockRestore();
  });

  it('errors for ambiguous formation name', async () => {
    // Two formations with same name, different namespace
    await writeState('ns1', 'shared-name', {
      a: { id: 'ns1-a', slug: 'a' },
    });
    await writeState('ns2', 'shared-name', {
      b: { id: 'ns2-b', slug: 'b' },
    });

    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

    const cap = captureConsole();
    try {
      await logs('shared-name', { lines: 50 });
      expect.unreachable('Expected process.exit');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit');
    } finally {
      cap.restore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = cap.errors.join('\n');
    expect(errorOutput).toContain('Multiple');

    mockExit.mockRestore();
  });
});

describe('reef logs --follow', () => {
  it('multi-agent follow includes both agent slug prefixes', async () => {
    await writeState('ns', 'myapp', {
      triage: { id: 'ns-triage', slug: 'triage' },
      worker: { id: 'ns-worker', slug: 'worker' },
    });
    await writeSessionLog('ns-triage', 'session-001.jsonl', [
      JSON.stringify({ message: 'Triage init' }),
    ]);
    await writeSessionLog('ns-worker', 'session-001.jsonl', [
      JSON.stringify({ message: 'Worker init' }),
    ]);

    const stdoutChunks: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      });

    const cap = captureConsole();

    // Start follow in background — it runs forever, so we race with a timeout
    const logsPromise = logs('ns/myapp', { follow: true, lines: 0 });

    // Wait a bit then append new content to trigger the watchers
    await new Promise((r) => setTimeout(r, 200));
    await appendFile(
      join(tempHome, 'agents', 'ns-triage', 'sessions', 'session-001.jsonl'),
      JSON.stringify({ message: 'Triage follow line' }) + '\n',
    );
    await appendFile(
      join(tempHome, 'agents', 'ns-worker', 'sessions', 'session-001.jsonl'),
      JSON.stringify({ message: 'Worker follow line' }) + '\n',
    );

    // Wait for watchers to fire (debounce is 100ms)
    await new Promise((r) => setTimeout(r, 500));

    // Force cleanup — send SIGINT to trigger cleanup handlers
    // Instead, we check what was already written
    const output = stdoutChunks.join('');
    // Verify agent slug prefixes appear in output
    expect(output).toContain('[triage]');
    expect(output).toContain('[worker]');

    process.emit('SIGINT', 'SIGINT');
    await logsPromise;

    writeSpy.mockRestore();
    cap.restore();
  });

  it('wait mode: prints waiting message when session dir is empty', async () => {
    await writeState('ns', 'myapp', {
      helper: { id: 'ns-helper', slug: 'helper' },
    });
    // Do NOT create any session files — agent dir exists but no sessions/

    const stdoutChunks: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      });

    const cap = captureConsole();

    // Start follow — helper has no session dir, should enter wait mode
    const logsPromise = logs('ns/myapp', { follow: true, lines: 0 });

    // Wait a bit for initialization
    await new Promise((r) => setTimeout(r, 300));

    const output = stdoutChunks.join('');
    expect(output).toContain('Waiting for sessions');
    expect(output).toContain('[helper]');

    // Now create session dir and write a file — the 2s poll should pick it up
    const sessionDir = join(tempHome, 'agents', 'ns-helper', 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'session-001.jsonl'),
      JSON.stringify({ message: 'First log line' }) + '\n',
    );

    // Wait for the 2s polling interval + debounce
    await new Promise((r) => setTimeout(r, 2500));

    // Append new content to trigger the file watcher
    await appendFile(
      join(sessionDir, 'session-001.jsonl'),
      JSON.stringify({ message: 'Second log line' }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 300));

    const finalOutput = stdoutChunks.join('');
    expect(finalOutput).toContain('[helper]');

    process.emit('SIGINT', 'SIGINT');
    await logsPromise;

    writeSpy.mockRestore();
    cap.restore();
  });
});
