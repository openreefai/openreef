import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'index.js');
const TEMPLATE = join(import.meta.dirname, '..', '..', 'template');

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [CLI, ...args]);
}

describe('reef inspect', () => {
  it('prints formation metadata', async () => {
    const { stdout } = await runCli('inspect', TEMPLATE);
    expect(stdout).toContain('my-formation');
    expect(stdout).toContain('0.1.0');
    expect(stdout).toContain('shoal');
  });

  it('prints agents section', async () => {
    const { stdout } = await runCli('inspect', TEMPLATE);
    expect(stdout).toContain('manager');
    expect(stdout).toContain('researcher');
  });

  it('prints variables section', async () => {
    const { stdout } = await runCli('inspect', TEMPLATE);
    expect(stdout).toContain('OPENAI_API_KEY');
    expect(stdout).toContain('MISSION_GOAL');
  });

  it('prints communication topology', async () => {
    const { stdout } = await runCli('inspect', TEMPLATE);
    // Should show topology arrows
    expect(stdout).toContain('manager');
    expect(stdout).toContain('researcher');
  });

  it('prints cron jobs', async () => {
    const { stdout } = await runCli('inspect', TEMPLATE);
    expect(stdout).toContain('0 9 * * 1-5');
  });

  it('prints dependencies', async () => {
    const { stdout } = await runCli('inspect', TEMPLATE);
    expect(stdout).toContain('web-search');
    expect(stdout).toContain('OpenAI API');
  });
});
