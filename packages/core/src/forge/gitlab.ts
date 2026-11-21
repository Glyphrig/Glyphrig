import { filePathToFolderPath, normalizeRepoRootDir } from '../markdown/slug.js';
import { mapWithConcurrency } from './encoding.js';
import {
  ForgeError,
  type CommitChangesInput,
  type ForgeAdapter,
  type ForgeAdapterConfig,
  type ReadBookmarkFilesResult,
  type RepoConnectionInfo,
} from './types.js';

function resolveGitLabBase(instanceUrl?: string): string {
  const clean = (instanceUrl?.trim() || 'https://gitlab.com').replace(/\/+$/, '');
  return clean.endsWith('/api/v4') ? clean : `${clean}/api/v4`;
}

export class GitLabAdapter implements ForgeAdapter {
  readonly kind = 'gitlab' as const;
  private readonly apiBase: string;
  private readonly projectId: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: ForgeAdapterConfig) {
    this.apiBase = resolveGitLabBase(config.instanceUrl);
    const fullPath = `${config.owner.trim()}/${config.repo.trim()}`;
    this.projectId = encodeURIComponent(fullPath);
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
          'PRIVATE-TOKEN': this.token,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      throw new ForgeError(
        err instanceof Error ? err.message : 'Network error calling GitLab API',
        0,
        'network',
      );
    }

    if (allowStatuses.includes(res.status)) {
      return res;
    }

    if (!res.ok) {
      let msg = `GitLab API error (${res.status})`;
      try {
        const data = (await res.json()) as { message?: unknown; error?: string };
        if (typeof data.message === 'string') msg = data.message;
        else if (data.error) msg = data.error;
      } catch {
        // ignore
      }
      const code =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 404
            ? 'not_found'
            : res.status === 409 || res.status === 400
              ? 'conflict'
              : res.status === 429
                ? 'rate_limit'
                : 'unknown';
      throw new ForgeError(msg, res.status, code);
    }
    return res;
  }

  async testConnection(branch?: string): Promise<RepoConnectionInfo> {
    const res = await this.request(`/projects/${this.projectId}`);
    const project = (await res.json()) as {
      path_with_namespace: string;
      default_branch: string;
      visibility: string;
      web_url?: string;
    };

    const targetBranch = branch?.trim() || project.default_branch || 'main';
    const headSha = await this.getHeadSha(targetBranch);

    return {
      forge: 'gitlab',
      fullName: project.path_with_namespace,
      defaultBranch: project.default_branch || 'main',
      branchExists: headSha !== null,
      headSha,
      private: project.visibility === 'private',
      htmlUrl: project.web_url,
    };
  }

  async getHeadSha(branch: string): Promise<string | null> {
    const res = await this.request(
      `/projects/${this.projectId}/repository/branches/${encodeURIComponent(branch)}`,
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

    const entries: Array<{ path: string; type: string; id: string }> = [];
    let page = 1;
    while (true) {
      const res = await this.request(
        `/projects/${this.projectId}/repository/tree?ref=${encodeURIComponent(commitSha)}&path=${encodeURIComponent(cleanRoot)}&recursive=true&per_page=100&page=${page}`,
        {},
        [404],
      );
      if (res.status === 404) {
        break;
      }
      const batch = (await res.json()) as Array<{
        path: string;
        type: string;
        id: string;
      }>;
      entries.push(...batch);
      const nextPage = res.headers.get('x-next-page');
      if (!nextPage) {
        break;
      }
      page = Number(nextPage);
      if (!Number.isFinite(page) || page <= 0) {
        break;
      }
    }

    const matchingBlobs = entries.filter(
      (item) =>
        item.type === 'blob' && filePathToFolderPath(cleanRoot, item.path) !== null,
    );

    const files = new Map<string, string>();
    const fileShas = new Map<string, string>();

    await mapWithConcurrency(matchingBlobs, 6, async (blob) => {
      const res = await this.request(
        `/projects/${this.projectId}/repository/files/${encodeURIComponent(blob.path)}/raw?ref=${encodeURIComponent(commitSha)}`,
      );
      const text = await res.text();
      files.set(blob.path, text);
      fileShas.set(blob.path, blob.id);
    });

    return { commitSha, files, fileShas };
  }

  async commitChanges(input: CommitChangesInput): Promise<{ commitSha: string }> {
    const { branch, parentSha, message, upserts, deletes, existingPaths } = input;
    if (upserts.size === 0 && deletes.length === 0) {
      return { commitSha: parentSha ?? '' };
    }

    // Optimistic concurrency guard: GitLab commits API doesn't reject on branch HEAD change
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

    let knownPaths = existingPaths;
    if (!knownPaths && parentSha) {
      knownPaths = new Set<string>();
      for (const path of upserts.keys()) {
        const check = await this.request(
          `/projects/${this.projectId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
          { method: 'HEAD' },
          [404],
        );
        if (check.status !== 404) {
          knownPaths.add(path);
        }
      }
    }

    const actions: Array<{
      action: 'create' | 'update' | 'delete';
      file_path: string;
      content?: string;
    }> = [];

    for (const [filePath, content] of upserts.entries()) {
      const exists = knownPaths ? knownPaths.has(filePath) : false;
      actions.push({
        action: exists ? 'update' : 'create',
        file_path: filePath,
        content,
      });
    }

    for (const filePath of deletes) {
      actions.push({
        action: 'delete',
        file_path: filePath,
      });
    }

    const res = await this.request(`/projects/${this.projectId}/repository/commits`, {
      method: 'POST',
      body: JSON.stringify({
        branch,
        commit_message: message,
        actions,
      }),
    });

    const data = (await res.json()) as { id: string };
    return { commitSha: data.id };
  }
}
