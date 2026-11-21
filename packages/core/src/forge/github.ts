import { normalizeUsername } from '../markdown/parse.js';
import { isBookmarkOrArchiveFilePath, normalizeRepoRootDir } from '../markdown/slug.js';
import {
  decodeBase64ToUtf8,
  encodeRefPath,
  encodeUtf8ToBase64,
  mapWithConcurrency,
} from './encoding.js';
import {
  ForgeError,
  type AuthenticatedUser,
  type CommitChangesInput,
  type ForgeAdapter,
  type ForgeAdapterConfig,
  type GitHubDeviceCodeResponse,
  type GitHubDeviceTokenPollResult,
  type ReadBookmarkFilesResult,
  type RepoConnectionInfo,
} from './types.js';

function resolveGitHubApiBase(instanceUrl?: string): string {
  if (!instanceUrl || !instanceUrl.trim()) {
    return 'https://api.github.com';
  }
  const clean = instanceUrl.trim().replace(/\/+$/, '');
  if (clean === 'https://github.com' || clean === 'https://api.github.com') {
    return 'https://api.github.com';
  }
  if (clean.endsWith('/api/v3')) {
    return clean;
  }
  return `${clean}/api/v3`;
}

function classifyHttpError(status: number, message: string): ForgeError {
  if (status === 401 || status === 403) {
    return new ForgeError(message, status, 'auth');
  }
  if (status === 404) {
    return new ForgeError(message, status, 'not_found');
  }
  if (status === 409 || status === 422) {
    return new ForgeError(message, status, 'conflict');
  }
  if (status === 429) {
    return new ForgeError(message, status, 'rate_limit');
  }
  return new ForgeError(message, status, 'unknown');
}

export class GitHubAdapter implements ForgeAdapter {
  readonly kind = 'github' as const;
  private readonly apiBase: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: ForgeAdapterConfig) {
    this.apiBase = resolveGitHubApiBase(config.instanceUrl);
    this.owner = config.owner.trim();
    this.repo = config.repo.trim();
    this.token = config.token.trim();
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
    allowStatuses: number[] = [],
  ): Promise<{ status: number; data: T | null }> {
    const url = `${this.apiBase}${path}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      throw new ForgeError(
        err instanceof Error ? err.message : 'Network error calling GitHub API',
        0,
        'network',
      );
    }

    if (allowStatuses.includes(res.status)) {
      return { status: res.status, data: null };
    }

    if (!res.ok) {
      let msg = `GitHub API error (${res.status})`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) msg = body.message;
      } catch {
        // ignore JSON parse failure on error body
      }
      throw classifyHttpError(res.status, msg);
    }

    if (res.status === 204) {
      return { status: 204, data: null };
    }
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    const { data } = await this.requestJson<{
      login?: string;
      name?: string;
      avatar_url?: string;
    }>('/user');
    const username = normalizeUsername(data?.login ?? '');
    if (!username) {
      throw new ForgeError('Unable to determine authenticated GitHub username', 500, 'unknown');
    }
    return {
      username,
      ...(data?.name ? { displayName: data.name } : {}),
      ...(data?.avatar_url ? { avatarUrl: data.avatar_url } : {}),
    };
  }

  async testConnection(branch?: string): Promise<RepoConnectionInfo> {
    const { data: repoInfo } = await this.requestJson<{
      full_name: string;
      default_branch: string;
      private: boolean;
      html_url?: string;
    }>(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`);

    if (!repoInfo) {
      throw new ForgeError('Repository not found', 404, 'not_found');
    }

    const targetBranch = branch?.trim() || repoInfo.default_branch;
    const headSha = await this.getHeadSha(targetBranch);

    return {
      forge: 'github',
      fullName: repoInfo.full_name,
      defaultBranch: repoInfo.default_branch,
      branchExists: headSha !== null,
      headSha,
      private: repoInfo.private,
      htmlUrl: repoInfo.html_url,
    };
  }

  async getHeadSha(branch: string): Promise<string | null> {
    const encoded = encodeRefPath(branch);
    const res = await this.requestJson<{ object?: { sha?: string } }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${encoded}`,
      {},
      [404, 409],
    );
    return res.data?.object?.sha ?? null;
  }

  async readBookmarkFiles(
    branch: string,
    rootDir: string,
  ): Promise<ReadBookmarkFilesResult> {
    const cleanRoot = normalizeRepoRootDir(rootDir);
    const commitSha = await this.getHeadSha(branch);
    if (!commitSha) {
      return { commitSha: null, files: new Map(), fileShas: new Map() };
    }

    const { data: commit } = await this.requestJson<{ tree: { sha: string } }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${commitSha}`,
    );
    if (!commit) {
      return { commitSha, files: new Map(), fileShas: new Map() };
    }

    const { data: treeRes } = await this.requestJson<{
      tree: Array<{ path: string; type: string; sha: string }>;
    }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${commit.tree.sha}?recursive=1`,
    );

    const matchingBlobs = (treeRes?.tree ?? []).filter(
      (item) =>
        item.type === 'blob' && isBookmarkOrArchiveFilePath(cleanRoot, item.path),
    );

    const files = new Map<string, string>();
    const fileShas = new Map<string, string>();

    await mapWithConcurrency(matchingBlobs, 6, async (blob) => {
      const { data: blobData } = await this.requestJson<{
        content: string;
        encoding: string;
      }>(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${blob.sha}`,
      );
      if (blobData) {
        const text =
          blobData.encoding === 'base64'
            ? decodeBase64ToUtf8(blobData.content)
            : blobData.content;
        files.set(blob.path, text);
        fileShas.set(blob.path, blob.sha);
      }
    });

    return { commitSha, files, fileShas };
  }

  async commitChanges(input: CommitChangesInput): Promise<{ commitSha: string }> {
    const { branch, message, upserts, deletes } = input;
    let { parentSha } = input;

    if (upserts.size === 0 && deletes.length === 0) {
      return { commitSha: parentSha ?? '' };
    }

    const remainingUpserts = new Map(upserts);

    // GitHub's Git Data API rejects blob creation on completely empty repos.
    // Seed the branch with the first file via the Contents API, then commit the rest atomically.
    if (!parentSha) {
      const firstEntry = remainingUpserts.entries().next();
      if (firstEntry.done) {
        throw new ForgeError('Cannot delete files from an empty repository', 409, 'conflict');
      }
      const [firstPath, firstContent] = firstEntry.value;
      remainingUpserts.delete(firstPath);

      const { data: initRes } = await this.requestJson<{
        commit: { sha: string };
      }>(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodeRefPath(firstPath)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            message: remainingUpserts.size === 0 ? message : `${message} (init)`,
            content: encodeUtf8ToBase64(firstContent),
            branch,
          }),
        },
      );
      parentSha = initRes?.commit.sha ?? null;
      if (!parentSha) {
        throw new ForgeError('Failed to initialize repository branch', 500, 'unknown');
      }
      if (remainingUpserts.size === 0 && deletes.length === 0) {
        return { commitSha: parentSha };
      }
    }

    const { data: parentCommit } = await this.requestJson<{ tree: { sha: string } }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${parentSha}`,
    );
    if (!parentCommit) {
      throw new ForgeError('Parent commit not found', 404, 'not_found');
    }

    const upsertEntries = [...remainingUpserts.entries()];
    const createdBlobs = await mapWithConcurrency(
      upsertEntries,
      6,
      async ([path, content]) => {
        const { data } = await this.requestJson<{ sha: string }>(
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs`,
          {
            method: 'POST',
            body: JSON.stringify({ content, encoding: 'utf-8' }),
          },
        );
        if (!data?.sha) {
          throw new ForgeError(`Failed to create blob for ${path}`, 500, 'unknown');
        }
        return {
          path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: data.sha,
        };
      },
    );

    const deleteEntries = deletes.map((path) => ({
      path,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: null,
    }));

    const { data: newTree } = await this.requestJson<{ sha: string }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: parentCommit.tree.sha,
          tree: [...createdBlobs, ...deleteEntries],
        }),
      },
    );
    if (!newTree?.sha) {
      throw new ForgeError('Failed to create Git tree', 500, 'unknown');
    }

    const { data: newCommit } = await this.requestJson<{ sha: string }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: newTree.sha,
          parents: [parentSha],
        }),
      },
    );
    if (!newCommit?.sha) {
      throw new ForgeError('Failed to create Git commit', 500, 'unknown');
    }

    await this.requestJson(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs/heads/${encodeRefPath(branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      },
    );

    return { commitSha: newCommit.sha };
  }
}

export async function requestGitHubDeviceCode(
  clientId: string,
  scope = 'repo',
  githubHost = 'https://github.com',
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GitHubDeviceCodeResponse> {
  const base = githubHost.trim().replace(/\/+$/, '');
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    scope,
  });

  const res = await fetchFn(`${base}/login/device/code`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new ForgeError(
      `GitHub Device Flow request failed (${res.status})`,
      res.status,
      res.status === 401 || res.status === 403 ? 'auth' : 'unknown',
    );
  }

  const data = (await res.json()) as GitHubDeviceCodeResponse & {
    error?: string;
    error_description?: string;
  };
  if (data.error) {
    throw new ForgeError(
      data.error_description || data.error,
      res.status,
      'auth',
    );
  }
  return data;
}

export async function pollGitHubDeviceToken(
  clientId: string,
  deviceCode: string,
  githubHost = 'https://github.com',
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GitHubDeviceTokenPollResult> {
  const base = githubHost.trim().replace(/\/+$/, '');
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  const res = await fetchFn(`${base}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    return {
      status: 'error',
      message: `GitHub token poll failed (${res.status})`,
    };
  }

  const data = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  if (data.access_token) {
    return {
      status: 'authorized',
      accessToken: data.access_token,
      tokenType: data.token_type ?? 'bearer',
      scope: data.scope ?? '',
    };
  }

  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending', interval: data.interval };
    case 'slow_down':
      return { status: 'slow_down', interval: data.interval ?? 10 };
    case 'expired_token':
      return {
        status: 'expired',
        message: data.error_description ?? 'Device code expired',
      };
    case 'access_denied':
      return {
        status: 'access_denied',
        message: data.error_description ?? 'Access denied by user',
      };
    default:
      return {
        status: 'error',
        message: data.error_description ?? data.error ?? 'Unknown OAuth error',
      };
  }
}
