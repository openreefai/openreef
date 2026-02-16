import { readFile } from 'node:fs/promises';
import { VERSION } from '../version.js';
import type { RegistryIndex } from './registry.js';

// ── Error classes ──

export class GitHubApiError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubAuthError extends GitHubApiError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'GitHubAuthError';
  }
}

export class GitHubConflictError extends GitHubApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'GitHubConflictError';
  }
}

export class PublishRollbackError extends Error {
  constructor(
    message: string,
    public originalError: Error,
    public releaseId: number,
    public tag: string,
  ) {
    super(message);
    this.name = 'PublishRollbackError';
  }
}

// ── Types ──

export interface GitHubApiOptions {
  token: string;
  owner?: string;
  repo?: string;
}

interface RequestOptions extends GitHubApiOptions {
  method?: string;
  path: string;
  body?: unknown;
  contentType?: string;
  rawBody?: Buffer;
  uploadUrl?: string;
}

// ── Helpers ──

function resolveOwnerRepo(options: GitHubApiOptions): { owner: string; repo: string } {
  return {
    owner: options.owner ?? 'openreefai',
    repo: options.repo ?? 'formations',
  };
}

async function githubRequest<T>(options: RequestOptions): Promise<T> {
  const { owner, repo } = resolveOwnerRepo(options);
  const baseUrl = options.uploadUrl ?? 'https://api.github.com';
  const url = options.uploadUrl
    ? options.path
    : `${baseUrl}/repos/${owner}/${repo}${options.path}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${options.token}`,
    'User-Agent': `@openreef/cli/${VERSION}`,
    'Accept': 'application/vnd.github+json',
  };

  let body: BodyInit | undefined;
  if (options.rawBody) {
    headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
    body = options.rawBody.buffer.slice(
      options.rawBody.byteOffset,
      options.rawBody.byteOffset + options.rawBody.byteLength,
    ) as ArrayBuffer;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  if (response.status === 401 || response.status === 403) {
    throw new GitHubAuthError(
      `GitHub authentication failed (HTTP ${response.status}). Check your token.`,
    );
  }

  if (response.status === 409 || response.status === 422) {
    const errBody = await response.text();
    throw new GitHubConflictError(
      `GitHub conflict (HTTP ${response.status}): ${errBody}`,
    );
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new GitHubApiError(
      `GitHub API error (HTTP ${response.status}): ${errBody}`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;

  return response.json() as Promise<T>;
}

// ── Core functions ──

export async function getRegistryIndex(
  options: GitHubApiOptions,
): Promise<{ content: RegistryIndex; sha: string } | null> {
  try {
    const result = await githubRequest<{
      content: string;
      sha: string;
      encoding: string;
    }>({
      ...options,
      path: '/contents/index.json',
    });

    const decoded = Buffer.from(result.content, 'base64').toString('utf-8');
    const content = JSON.parse(decoded) as RegistryIndex;
    return { content, sha: result.sha };
  } catch (err) {
    if (err instanceof GitHubApiError && err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function createDraftRelease(
  tag: string,
  name: string,
  body: string,
  options: GitHubApiOptions,
): Promise<{ releaseId: number; uploadUrl: string }> {
  const result = await githubRequest<{
    id: number;
    upload_url: string;
  }>({
    ...options,
    method: 'POST',
    path: '/releases',
    body: {
      tag_name: tag,
      name,
      body,
      draft: true,
    },
  });

  // upload_url has template like "https://uploads.github.com/.../assets{?name,label}"
  const uploadUrl = result.upload_url.replace(/\{[^}]*\}/, '');

  return { releaseId: result.id, uploadUrl };
}

export async function uploadReleaseAsset(
  releaseId: number,
  tarballPath: string,
  options: GitHubApiOptions,
): Promise<{ assetUrl: string }> {
  const { owner, repo } = resolveOwnerRepo(options);
  const tarballBuffer = await readFile(tarballPath);
  const fileName = tarballPath.split('/').pop()!;

  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;

  const result = await githubRequest<{ browser_download_url: string }>({
    ...options,
    method: 'POST',
    path: url,
    uploadUrl: url,
    rawBody: tarballBuffer,
    contentType: 'application/gzip',
  });

  return { assetUrl: result.browser_download_url };
}

export async function publishRelease(
  releaseId: number,
  options: GitHubApiOptions,
): Promise<void> {
  await githubRequest({
    ...options,
    method: 'PATCH',
    path: `/releases/${releaseId}`,
    body: { draft: false },
  });
}

export async function deleteRelease(
  releaseId: number,
  options: GitHubApiOptions,
): Promise<void> {
  await githubRequest({
    ...options,
    method: 'DELETE',
    path: `/releases/${releaseId}`,
  });
}

export async function updateRegistryIndex(
  index: RegistryIndex,
  sha: string | undefined,
  commitMessage: string,
  options: GitHubApiOptions,
): Promise<void> {
  const content = Buffer.from(
    JSON.stringify(index, null, 2) + '\n',
  ).toString('base64');

  const body: Record<string, string> = {
    message: commitMessage,
    content,
  };
  if (sha) {
    body.sha = sha;
  }

  await githubRequest({
    ...options,
    method: 'PUT',
    path: '/contents/index.json',
    body,
  });
}
