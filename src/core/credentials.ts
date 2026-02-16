import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.openreef');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');

interface Credentials {
  [registryUrl: string]: { token: string };
}

async function loadCredentials(): Promise<Credentials> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return {};
  }
}

async function saveCredentials(creds: Credentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export async function storeToken(registryUrl: string, token: string): Promise<void> {
  const creds = await loadCredentials();
  creds[registryUrl] = { token };
  await saveCredentials(creds);
}

export async function getStoredToken(registryUrl: string): Promise<string | null> {
  const creds = await loadCredentials();
  return creds[registryUrl]?.token ?? null;
}

export async function removeToken(registryUrl: string): Promise<void> {
  const creds = await loadCredentials();
  delete creds[registryUrl];
  await saveCredentials(creds);
}

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}
