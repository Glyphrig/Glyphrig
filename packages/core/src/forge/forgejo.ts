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
  type ReadBookmarkFilesResult,
  type RepoConnectionInfo,
} from './types.js';

function resolveForgejoApiBase(instanceUrl?: string): string {
  const clean = (instanceUrl?.trim() || 'https://codeberg.org').replace(/\/+$/, '');
  return clean.endsWith('/api/v1') ? clean : `${clean}/api/v1`;
}

export class ForgejoAdapter implements ForgeAdapter {
  readonly kind = 'forgejo' as const;
  private readonly apiBase: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: ForgeAdapterConfig) {
    this.apiBase = resolveForgejoApiBase(config.instanceUrl);
    this.owner = config.owner.trim();
    this.repo = config.repo.trim();
    this.token = config.token.trim();
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowStatuses: number[] = [],
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `token ${this.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      throw new ForgeError(
        err instanceof Error ? err.message : 'Network error calling Forgejo/Gitea API',
        0,
        'network',
      );
    }

    if (allowStatuses.includes(res.status)) {
      return res;
    }

    if (!res.ok) {
      let msg = `Forgejo API error (${res.status})`;
      try {
        const data = (await res.json()) as { message?: string };
        if (data.message) msg = data.message;
      } catch {
        // ignore
      }
      const code =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 404
            ? 'not_found'
            : res.status === 409 || res.status === 422
              ? 'conflict'
              : res.status === 429
                ? 'rate_limit'
                : 'unknown';
      throw new ForgeError(msg, res.status, code);
    }

    return res;
  }

  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    const res = await this.request('/user');
    const data = (await res.json()) as {
      login?: string;
      username?: string;
      full_name?: string;
      avatar_url?: string;
    };
    const username = normalizeUsername(data.login ?? data.username ?? '');
    if (!username) {
      throw new ForgeError('Unable to determine authenticated Forgejo username', 500, 'unknown');
    }
    return {
      username,
      ...(data.full_name ? { displayName: data.full_name } : {}),
      ...(data.avatar_url ? { avatarUrl: data.avatar_url } : {}),
    };
  }

  async testConnection(branch?: string): Promise<RepoConnectionInfo> {
    const res = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`,
    );
    const repoInfo = (await res.json()) as {
      full_name: string;
      default_branch: string;
      private: boolean;
      html_url?: string;
    };

    const targetBranch = branch?.trim() || repoInfo.default_branch || 'main';
    const headSha = await this.getHeadSha(targetBranch);

    return {
      forge: 'forgejo',
      fullName: repoInfo.full_name,
      defaultBranch: repoInfo.default_branch || 'main',
      branchExists: headSha !== null,
      headSha,
      private: repoInfo.private,
      htmlUrl: repoInfo.html_url,
    };
  }

  async getHeadSha(branch: string): Promise<string | null> {
    const res = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(branch)}`,
      {},
      [404],
    );
    if (res.status === 404) {
      return null;
    }
    const data = (await res.json()) as { commit?: { id?: string } };
    return data.commit?.id ?? null;
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

    const res = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
      {},
      [404, 409],
    );
    if (res.status === 404 || res.status === 409) {
      return { commitSha, files: new Map(), fileShas: new Map() };
    }

    const treeData = (await res.json()) as {
      tree?: Array<{ path: string; type: string; sha: string }>;
    };

    const matchingBlobs = (treeData.tree ?? []).filter(
      (item) =>
        item.type === 'blob' && isBookmarkOrArchiveFilePath(cleanRoot, item.path),
    );

    const files = new Map<string, string>();
    const fileShas = new Map<string, string>();

    await mapWithConcurrency(matchingBlobs, 6, async (blob) => {
      const blobRes = await this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${blob.sha}`,
      );
      const blobData = (await blobRes.json()) as { content: string; encoding?: string };
      const text =
        blobData.encoding === 'base64' || blobData.encoding === undefined
          ? decodeBase64ToUtf8(blobData.content)
          : blobData.content;
      files.set(blob.path, text);
      fileShas.set(blob.path, blob.sha);
    });

    return { commitSha, files, fileShas };
  }

  private async getFileSha(branch: string, filePath: string): Promise<string | null> {
    const res = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodeRefPath(filePath)}?ref=${encodeURIComponent(branch)}`,
      {},
      [404],
    );
    if (res.status === 404) {
      return null;
    }
    const data = (await res.json()) as { sha?: string };
    return data.sha ?? null;
  }

  async commitChanges(input: CommitChangesInput): Promise<{ commitSha: string }> {
    const { branch, parentSha, message, upserts, deletes, existingFileShas } = input;
    if (upserts.size === 0 && deletes.length === 0) {
      return { commitSha: parentSha ?? '' };
    }

    if (parentSha) {
      const currentHead = await this.getHeadSha(branch);
      if (currentHead && currentHead !== parentSha) {
        throw new ForgeError(
          `Branch "${branch}" advanced from ${parentSha} to ${currentHead}`,
          409,
          'conflict',
        );
      }
    }

    const batchFiles: Array<{
      operation: 'create' | 'update' | 'delete';
      path: string;
      content?: string;
      sha?: string;
    }> = [];

    for (const [filePath, content] of upserts.entries()) {
      const knownSha =
        existingFileShas?.get(filePath) ??
        (parentSha ? await this.getFileSha(branch, filePath) : null);
      batchFiles.push({
        operation: knownSha ? 'update' : 'create',
        path: filePath,
        content: encodeUtf8ToBase64(content),
        ...(knownSha ? { sha: knownSha } : {}),
      });
    }

    for (const filePath of deletes) {
      const knownSha =
        existingFileShas?.get(filePath) ??
        (parentSha ? await this.getFileSha(branch, filePath) : null);
      if (!knownSha) {
        continue;
      }
      batchFiles.push({
        operation: 'delete',
        path: filePath,
        sha: knownSha,
      });
    }

    if (batchFiles.length === 0) {
      return { commitSha: parentSha ?? '' };
    }

    // Attempt Forgejo/Gitea batch contents commit endpoint first
    const batchRes = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents`,
      {
        method: 'POST',
        body: JSON.stringify({
          branch,
          message,
          files: batchFiles,
        }),
      },
      [404, 405],
    );

    if (batchRes.status !== 404 && batchRes.status !== 405) {
      const result = (await batchRes.json()) as { commit?: { sha?: string } };
      return {
        commitSha: result.commit?.sha ?? (await this.getHeadSha(branch)) ?? '',
      };
    }

    // Fallback for older Gitea instances without batch contents API
    let latestSha = parentSha ?? '';
    for (const item of batchFiles) {
      const method =
        item.operation === 'create'
          ? 'POST'
          : item.operation === 'update'
            ? 'PUT'
            : 'DELETE';
      const payload: Record<string, unknown> = {
        branch,
        message,
        ...(item.sha ? { sha: item.sha } : {}),
        ...(item.content !== undefined ? { content: item.content } : {}),
      };
      const itemRes = await this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodeRefPath(item.path)}`,
        {
          method,
          body: JSON.stringify(payload),
        },
      );
      const data = (await itemRes.json()) as { commit?: { sha?: string } };
      if (data.commit?.sha) {
        latestSha = data.commit.sha;
      }
    }

    return { commitSha: latestSha };
  }
}
