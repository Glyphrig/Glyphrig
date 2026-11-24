import { describe, expect, it } from 'vitest';
import {
  createForgeAdapter,
  encodeUtf8ToBase64,
  pollGitHubDeviceToken,
  refreshGitHubDeviceToken,
  requestGitHubDeviceCode,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Forge adapters', () => {
  it('reads and atomically commits via GitHub Git Data API', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/git/ref/heads/main') && method === 'GET') {
        return jsonResponse({ object: { sha: 'commit-1' } });
      }
      if (url.endsWith('/git/commits/commit-1') && method === 'GET') {
        return jsonResponse({ tree: { sha: 'tree-1' } });
      }
      if (url.includes('/git/trees/tree-1?recursive=1')) {
        return jsonResponse({
          tree: [{ path: 'bookmarks/README.md', type: 'blob', sha: 'blob-1' }],
        });
      }
      if (url.endsWith('/git/blobs/blob-1')) {
        return jsonResponse({
          content: encodeUtf8ToBase64('---\ntitle: Bookmarks\n---\n'),
          encoding: 'base64',
        });
      }
      if (url.endsWith('/git/blobs') && method === 'POST') {
        return jsonResponse({ sha: 'blob-new' }, 201);
      }
      if (url.endsWith('/git/trees') && method === 'POST') {
        return jsonResponse({ sha: 'tree-new' }, 201);
      }
      if (url.endsWith('/git/commits') && method === 'POST') {
        return jsonResponse({ sha: 'commit-2' }, 201);
      }
      if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') {
        return jsonResponse({ object: { sha: 'commit-2' } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const adapter = createForgeAdapter({
      forge: 'github',
      owner: 'glyphrig',
      repo: 'my-bookmarks',
      token: 'ghp_test',
      fetchFn: mockFetch,
    });

    const read = await adapter.readBookmarkFiles('main', 'bookmarks');
    expect(read.commitSha).toBe('commit-1');
    expect(read.files.get('bookmarks/README.md')).toContain('title: Bookmarks');

    const commit = await adapter.commitChanges({
      branch: 'main',
      parentSha: 'commit-1',
      message: 'Sync bookmarks',
      upserts: new Map([['bookmarks/dev/README.md', '---\ntitle: Dev\n---\n']]),
      deletes: ['bookmarks/old/README.md'],
    });

    expect(commit.commitSha).toBe('commit-2');
    const treePost = calls.find((c) => c.url.endsWith('/git/trees') && c.method === 'POST');
    expect(treePost?.body).toMatchObject({
      base_tree: 'tree-1',
      tree: [
        { path: 'bookmarks/dev/README.md', sha: 'blob-new' },
        { path: 'bookmarks/old/README.md', sha: null },
      ],
    });
  });

  it('handles GitHub OAuth Device Flow code request and polling', async () => {
    let pollStep = 0;
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/login/device/code')) {
        return jsonResponse({
          device_code: 'dev-code-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      }
      pollStep++;
      if (pollStep === 1) {
        return jsonResponse({ error: 'authorization_pending' });
      }
      return jsonResponse({
        access_token: 'gho_secret_token',
        token_type: 'bearer',
        scope: 'repo',
      });
    };

    const code = await requestGitHubDeviceCode('client-123', 'repo', 'https://github.com', mockFetch);
    expect(code.user_code).toBe('ABCD-1234');

    const firstPoll = await pollGitHubDeviceToken('client-123', code.device_code, 'https://github.com', mockFetch);
    expect(firstPoll.status).toBe('pending');

    const secondPoll = await pollGitHubDeviceToken('client-123', code.device_code, 'https://github.com', mockFetch);
    expect(secondPoll).toMatchObject({
      status: 'authorized',
      accessToken: 'gho_secret_token',
    });
  });

  it('captures expiring token metadata and refreshes rotating GitHub refresh tokens', async () => {
    const refreshCalls: string[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const bodyStr = String(init?.body ?? '');
      refreshCalls.push(bodyStr);
      const params = new URLSearchParams(bodyStr);

      if (params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        return jsonResponse({
          access_token: 'ghu_initial_token',
          token_type: 'bearer',
          scope: 'repo',
          expires_in: 28800,
          refresh_token: 'ghr_refresh_1',
          refresh_token_expires_in: 15897600,
        });
      }

      if (params.get('grant_type') === 'refresh_token') {
        if (params.get('refresh_token') === 'ghr_expired') {
          return jsonResponse({
            error: 'bad_refresh_token',
            error_description: 'The refresh token passed is incorrect or expired.',
          });
        }
        return jsonResponse({
          access_token: 'ghu_rotated_token',
          token_type: 'bearer',
          scope: '',
          expires_in: 28800,
          refresh_token: 'ghr_refresh_2',
          refresh_token_expires_in: 15897600,
        });
      }

      return jsonResponse({ error: 'unexpected' }, 500);
    };

    const pollRes = await pollGitHubDeviceToken('Ov23liTest', 'dev-1', 'https://github.com', mockFetch);
    expect(pollRes).toEqual({
      status: 'authorized',
      accessToken: 'ghu_initial_token',
      tokenType: 'bearer',
      scope: 'repo',
      expiresIn: 28800,
      refreshToken: 'ghr_refresh_1',
      refreshTokenExpiresIn: 15897600,
    });

    const refreshed = await refreshGitHubDeviceToken(
      'Ov23liTest',
      'ghr_refresh_1',
      'https://github.com',
      mockFetch,
    );
    expect(refreshed).toEqual({
      status: 'refreshed',
      accessToken: 'ghu_rotated_token',
      tokenType: 'bearer',
      scope: '',
      expiresIn: 28800,
      refreshToken: 'ghr_refresh_2',
      refreshTokenExpiresIn: 15897600,
    });
    expect(refreshCalls[1]).toContain('grant_type=refresh_token');
    expect(refreshCalls[1]).toContain('client_id=Ov23liTest');

    const badRefresh = await refreshGitHubDeviceToken(
      'Ov23liTest',
      'ghr_expired',
      'https://github.com',
      mockFetch,
    );
    expect(badRefresh).toEqual({
      status: 'error',
      errorCode: 'bad_refresh_token',
      message: 'The refresh token passed is incorrect or expired.',
    });

    const httpFail = await refreshGitHubDeviceToken(
      'Ov23liTest',
      'ghr_refresh_1',
      'https://github.com',
      async () => new Response('Server Error', { status: 500 }),
    );
    expect(httpFail).toEqual({
      status: 'error',
      message: 'GitHub token refresh failed (500)',
    });
  });

  it('commits atomically via GitLab repository/commits API', async () => {
    let commitPayload: unknown;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.includes('/repository/branches/main')) {
        return jsonResponse({ commit: { id: 'gl-1' } });
      }
      if (url.includes('/repository/tree')) {
        return jsonResponse(
          [{ path: 'bookmarks/README.md', type: 'blob', id: 'gl-blob-1' }],
          200,
          { 'x-next-page': '' },
        );
      }
      if (url.includes('/repository/files/')) {
        return new Response('---\ntitle: GL\n---\n', { status: 200 });
      }
      if (url.endsWith('/repository/commits') && method === 'POST') {
        commitPayload = JSON.parse(String(init?.body));
        return jsonResponse({ id: 'gl-2' }, 201);
      }
      throw new Error(`Unexpected GitLab fetch: ${method} ${url}`);
    };

    const adapter = createForgeAdapter({
      forge: 'gitlab',
      owner: 'group/sub',
      repo: 'links',
      token: 'glpat-test',
      fetchFn: mockFetch,
    });

    const read = await adapter.readBookmarkFiles('main', 'bookmarks');
    expect(read.files.get('bookmarks/README.md')).toContain('title: GL');

    const res = await adapter.commitChanges({
      branch: 'main',
      parentSha: 'gl-1',
      message: 'Sync',
      upserts: new Map([
        ['bookmarks/README.md', 'updated'],
        ['bookmarks/new/README.md', 'created'],
      ]),
      deletes: ['bookmarks/old/README.md'],
      existingPaths: new Set(['bookmarks/README.md']),
    });

    expect(res.commitSha).toBe('gl-2');
    expect(commitPayload).toMatchObject({
      branch: 'main',
      commit_message: 'Sync',
      actions: [
        { action: 'update', file_path: 'bookmarks/README.md', content: 'updated' },
        { action: 'create', file_path: 'bookmarks/new/README.md', content: 'created' },
        { action: 'delete', file_path: 'bookmarks/old/README.md' },
      ],
    });
  });

  it('commits via Forgejo/Codeberg batch contents API with file SHA preservation', async () => {
    let batchBody: unknown;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/branches/main')) {
        return jsonResponse({ commit: { id: 'fj-1' } });
      }
      if (url.includes('/git/trees/fj-1')) {
        return jsonResponse({
          tree: [{ path: 'bookmarks/README.md', type: 'blob', sha: 'fj-blob-1' }],
        });
      }
      if (url.endsWith('/git/blobs/fj-blob-1')) {
        return jsonResponse({
          content: encodeUtf8ToBase64('---\ntitle: Codeberg\n---\n'),
          encoding: 'base64',
        });
      }
      if (url.endsWith('/contents') && method === 'POST') {
        batchBody = JSON.parse(String(init?.body));
        return jsonResponse({ commit: { sha: 'fj-2' } }, 201);
      }
      throw new Error(`Unexpected Forgejo fetch: ${method} ${url}`);
    };

    const adapter = createForgeAdapter({
      forge: 'forgejo',
      instanceUrl: 'https://codeberg.org',
      owner: 'alice',
      repo: 'links',
      token: 'cb-token',
      fetchFn: mockFetch,
    });

    const read = await adapter.readBookmarkFiles('main', 'bookmarks');
    expect(read.fileShas.get('bookmarks/README.md')).toBe('fj-blob-1');

    const res = await adapter.commitChanges({
      branch: 'main',
      parentSha: 'fj-1',
      message: 'Batch sync',
      upserts: new Map([['bookmarks/README.md', 'new text']]),
      deletes: [],
      existingFileShas: read.fileShas,
    });

    expect(res.commitSha).toBe('fj-2');
    expect(batchBody).toMatchObject({
      branch: 'main',
      message: 'Batch sync',
      files: [
        {
          operation: 'update',
          path: 'bookmarks/README.md',
          sha: 'fj-blob-1',
          content: encodeUtf8ToBase64('new text'),
        },
      ],
    });
  });

  it('fetches authenticated user login across GitHub, GitLab, and Forgejo adapters', async () => {
    const ghAdapter = createForgeAdapter({
      forge: 'github',
      owner: 'o',
      repo: 'r',
      token: 't',
      fetchFn: async () => jsonResponse({ login: 'AliceDev', name: 'Alice' }),
    });
    expect((await ghAdapter.getAuthenticatedUser()).username).toBe('alicedev');

    const glAdapter = createForgeAdapter({
      forge: 'gitlab',
      owner: 'o',
      repo: 'r',
      token: 't',
      fetchFn: async () => jsonResponse({ username: 'Bob_GL' }),
    });
    expect((await glAdapter.getAuthenticatedUser()).username).toBe('bob_gl');

    const fjAdapter = createForgeAdapter({
      forge: 'forgejo',
      owner: 'o',
      repo: 'r',
      token: 't',
      fetchFn: async () => jsonResponse({ login: 'Carol-CB' }),
    });
    expect((await fjAdapter.getAuthenticatedUser()).username).toBe('carol-cb');
  });
});
