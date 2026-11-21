import { describe, expect, it } from 'vitest';
import {
  ForgeError,
  SyncEngine,
  normalizeUrl,
  serializeBookmarkTree,
  threeWayMerge,
  type BookmarkEntry,
  type BookmarkTree,
  type CommitChangesInput,
  type FolderNode,
  type ForgeAdapter,
  type ReadBookmarkFilesResult,
  type RepoConnectionInfo,
} from '../src/index.js';

function bm(
  title: string,
  url: string,
  extra: Partial<BookmarkEntry> = {},
): BookmarkEntry {
  return {
    title,
    url,
    normalizedUrl: normalizeUrl(url),
    tags: extra.tags ?? [],
    order: extra.order ?? 0,
    ...(extra.note !== undefined ? { note: extra.note } : {}),
    ...(extra.added !== undefined ? { added: extra.added } : {}),
  };
}

function treeFrom(root: Partial<FolderNode> & { children?: FolderNode[] }): BookmarkTree {
  return {
    root: {
      path: '',
      slug: '',
      title: root.title ?? 'Public Bookmarks',
      order: 0,
      bookmarks: root.bookmarks ?? [],
      children: root.children ?? [],
      ...(root.description ? { description: root.description } : {}),
      ...(root.introMarkdown ? { introMarkdown: root.introMarkdown } : {}),
    },
  };
}

class InMemoryForgeAdapter implements ForgeAdapter {
  readonly kind = 'github' as const;
  headSha: string | null;
  files: Map<string, string>;
  commitCalls: CommitChangesInput[] = [];
  failFirstConflict = false;

  constructor(headSha: string | null, files: Map<string, string>) {
    this.headSha = headSha;
    this.files = new Map(files);
  }

  async testConnection(): Promise<RepoConnectionInfo> {
    return {
      forge: 'github',
      fullName: 'glyphrig/test',
      defaultBranch: 'main',
      branchExists: this.headSha !== null,
      headSha: this.headSha,
      private: false,
    };
  }

  async getHeadSha(): Promise<string | null> {
    return this.headSha;
  }

  async readBookmarkFiles(): Promise<ReadBookmarkFilesResult> {
    return {
      commitSha: this.headSha,
      files: new Map(this.files),
      fileShas: new Map(),
    };
  }

  async commitChanges(input: CommitChangesInput): Promise<{ commitSha: string }> {
    this.commitCalls.push(input);
    if (this.failFirstConflict) {
      this.failFirstConflict = false;
      this.headSha = 'sha-remote-advanced';
      throw new ForgeError('Head moved', 422, 'conflict');
    }
    for (const [k, v] of input.upserts.entries()) {
      this.files.set(k, v);
    }
    for (const d of input.deletes) {
      this.files.delete(d);
    }
    this.headSha = `sha-${this.commitCalls.length}`;
    return { commitSha: this.headSha };
  }
}

describe('threeWayMerge & SyncEngine', () => {
  it('performs non-destructive initial union sync when base is null', () => {
    const local = treeFrom({
      bookmarks: [bm('Local Only', 'https://local.example.org', { order: 0 })],
    });
    const remote = treeFrom({
      bookmarks: [
        bm('Remote Only', 'https://remote.example.org', {
          note: 'Curated',
          tags: ['reading'],
          order: 0,
        }),
      ],
    });

    const res = threeWayMerge(null, local, remote);
    const urls = res.merged.root.bookmarks.map((b) => b.url);
    expect(urls).toContain('https://local.example.org');
    expect(urls).toContain('https://remote.example.org');
    expect(res.localPatchNeeded).toBe(true);
    expect(res.conflicts).toHaveLength(0);
  });

  it('preserves hand-edited remote notes and tags when browser moves a bookmark across folders', () => {
    const base = treeFrom({
      children: [
        {
          path: 'dev',
          slug: 'dev',
          title: 'Dev',
          order: 0,
          bookmarks: [
            bm('Astro', 'https://astro.build', {
              note: 'Fast SSG',
              tags: ['web'],
              added: '2026-11-01',
            }),
          ],
          children: [],
        },
        {
          path: 'tools',
          slug: 'tools',
          title: 'Tools',
          order: 1,
          bookmarks: [],
          children: [],
        },
      ],
    });

    // Browser moved Astro from dev -> tools (browser lacks note/tags/added)
    const local = treeFrom({
      children: [
        { path: 'dev', slug: 'dev', title: 'Dev', order: 0, bookmarks: [], children: [] },
        {
          path: 'tools',
          slug: 'tools',
          title: 'Tools',
          order: 1,
          bookmarks: [bm('Astro Docs', 'https://astro.build')],
          children: [],
        },
      ],
    });

    const remote = structuredClone(base);

    const res = threeWayMerge(base, local, remote);
    expect(res.conflicts).toHaveLength(0);
    const toolsFolder = res.merged.root.children.find((c) => c.path === 'tools');
    expect(toolsFolder?.bookmarks).toHaveLength(1);
    expect(toolsFolder?.bookmarks[0]?.title).toBe('Astro Docs');
    expect(toolsFolder?.bookmarks[0]?.note).toBe('Fast SSG');
    expect(toolsFolder?.bookmarks[0]?.tags).toEqual(['web']);
    expect(toolsFolder?.bookmarks[0]?.added).toBe('2026-11-01');
  });

  it('resolves edit-vs-delete by keeping the edited bookmark and logging a conflict', () => {
    const base = treeFrom({
      bookmarks: [bm('Vite', 'https://vite.dev')],
    });
    const local = treeFrom({ bookmarks: [] }); // local deleted
    const remote = treeFrom({
      bookmarks: [bm('Vite Build Tool', 'https://vite.dev', { note: 'Updated note' })],
    });

    const res = threeWayMerge(base, local, remote);
    expect(res.merged.root.bookmarks).toHaveLength(1);
    expect(res.merged.root.bookmarks[0]?.title).toBe('Vite Build Tool');
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]?.kind).toBe('edit-vs-delete');
    expect(res.conflicts[0]?.resolution).toBe('kept-edited');
  });

  it('resolves edit-vs-edit with remote winning and logging the conflict', () => {
    const base = treeFrom({
      bookmarks: [bm('WXT', 'https://wxt.dev')],
    });
    const local = treeFrom({
      bookmarks: [bm('WXT Local Title', 'https://wxt.dev')],
    });
    const remote = treeFrom({
      bookmarks: [bm('WXT Remote Title', 'https://wxt.dev')],
    });

    const res = threeWayMerge(base, local, remote);
    expect(res.merged.root.bookmarks[0]?.title).toBe('WXT Remote Title');
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]?.kind).toBe('title-conflict');
    expect(res.conflicts[0]?.resolution).toBe('remote-won');
  });

  it('supports dry-run previews without committing and retries on optimistic head conflicts', async () => {
    const baseTree = treeFrom({
      bookmarks: [bm('Initial', 'https://example.org')],
    });
    const files = serializeBookmarkTree(baseTree, 'bookmarks');
    const adapter = new InMemoryForgeAdapter('sha-0', files);
    const engine = new SyncEngine();

    const localTree = treeFrom({
      bookmarks: [
        bm('Initial', 'https://example.org', { order: 0 }),
        bm('New Link', 'https://new.example.org?utm_source=x', { order: 1 }),
        bm('Localhost', 'http://localhost:8080', { order: 2 }),
      ],
    });

    const dryRes = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree,
      snapshot: {
        lastSyncedCommitSha: 'sha-0',
        lastSyncedAt: '2026-11-20T00:00:00.000Z',
        lastSyncedTree: baseTree,
      },
      dryRun: true,
    });

    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.committed).toBe(false);
    expect(adapter.commitCalls).toHaveLength(0);
    expect(dryRes.skipped).toHaveLength(1);
    expect(dryRes.cleanedUrls).toHaveLength(1);
    expect(dryRes.summary.addedBookmarks).toHaveLength(1);

    // Live sync with simulated stale head retry
    adapter.failFirstConflict = true;
    const liveRes = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree,
      snapshot: {
        lastSyncedCommitSha: 'sha-0',
        lastSyncedAt: '2026-11-20T00:00:00.000Z',
        lastSyncedTree: baseTree,
      },
    });

    expect(liveRes.committed).toBe(true);
    expect(adapter.commitCalls).toHaveLength(2);
    expect(adapter.files.get('bookmarks/README.md')).toContain('https://new.example.org');
    expect(adapter.files.get('bookmarks/README.md')).not.toContain('localhost');
  });
});
