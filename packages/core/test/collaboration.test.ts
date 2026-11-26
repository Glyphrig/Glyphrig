import { describe, expect, it, vi } from 'vitest';
import {
  GitHubAdapter,
  SyncEngine,
  applyAutoTagRules,
  assignSiblingSlugs,
  buildSuggestBookmarkUrl,
  decodeGlyphrigInvite,
  encodeGlyphrigInvite,
  inspectUrlSafety,
  parseFolderMarkdown,
  serializeFolderMarkdown,
  type BookmarkTree,
  type ForgeAdapter,
  type ProposeChangesInput,
} from '../src/index.js';

function makeTree(bookmarks: BookmarkTree['root']['bookmarks']): BookmarkTree {
  return {
    root: {
      path: '',
      slug: '',
      title: 'Team Bookmarks',
      order: 0,
      bookmarks,
      children: [],
    },
  };
}

describe('per-contributor notes, archiveUrl & maintainers markdown round-trip', () => {
  it('parses and serializes indented contributor sub-notes, archive URLs, and maintainers', () => {
    const md = [
      '---',
      'title: Architecture',
      'order: 1',
      'maintainers:',
      '  - alice',
      '  - bob',
      '---',
      '',
      'Curated systems references.',
      '',
      '- [Zero-Copy Parsing](https://example.com/zero-copy) — Core reference `#rust` `#perf` <!-- glyphrig: added=2026-11-20 by=alice,bob archive=https://web.archive.org/web/20261120/https://example.com/zero-copy -->',
      '  - **@alice**: Great benchmark breakdown',
      '  - **@bob**: Used this pattern in the ingestion worker',
      '',
    ].join('\n');

    const parsed = parseFolderMarkdown(md, 'architecture');
    expect(parsed.maintainers).toEqual(['alice', 'bob']);
    expect(parsed.bookmarks).toHaveLength(1);
    const bm = parsed.bookmarks[0]!;
    expect(bm.note).toBe('Core reference');
    expect(bm.tags).toEqual(['rust', 'perf']);
    expect(bm.savedBy).toEqual(['alice', 'bob']);
    expect(bm.archiveUrl).toBe(
      'https://web.archive.org/web/20261120/https://example.com/zero-copy',
    );
    expect(bm.contributorNotes).toEqual({
      alice: 'Great benchmark breakdown',
      bob: 'Used this pattern in the ingestion worker',
    });

    const out = serializeFolderMarkdown(
      {
        path: 'architecture',
        slug: 'architecture',
        title: parsed.title!,
        order: parsed.order!,
        maintainers: parsed.maintainers,
        bookmarks: parsed.bookmarks,
        children: [],
      },
      parsed,
    );

    expect(out).toContain('maintainers:\n  - alice\n  - bob');
    expect(out).toContain(
      'archive=https://web.archive.org/web/20261120/https://example.com/zero-copy',
    );
    expect(out).toContain('  - **@alice**: Great benchmark breakdown');
    expect(out).toContain('  - **@bob**: Used this pattern in the ingestion worker');
  });
});

describe('subscribe-only, propose-pr, and localAnnotations in SyncEngine', () => {
  it('subscribe-only mirrors remote to browser without ever committing', async () => {
    const commitSpy = vi.fn();
    const remoteMd = [
      '---',
      'title: Shared Garden',
      'order: 0',
      '---',
      '',
      '- [Remote Link](https://example.org/a) `#oss` <!-- glyphrig: added=2026-11-01 by=alice -->',
      '',
    ].join('\n');

    const adapter: ForgeAdapter = {
      kind: 'github',
      getAuthenticatedUser: async () => ({ username: 'anon' }),
      testConnection: async () => ({
        forge: 'github',
        fullName: 'org/garden',
        defaultBranch: 'main',
        branchExists: true,
        headSha: 'sha1',
        private: false,
      }),
      getHeadSha: async () => 'sha1',
      readBookmarkFiles: async () => ({
        commitSha: 'sha1',
        files: new Map([['bookmarks/README.md', remoteMd]]),
        fileShas: new Map([['bookmarks/README.md', 'b1']]),
      }),
      commitChanges: commitSpy,
    };

    const localTree = makeTree([
      {
        title: 'Unsynced Local Only',
        url: 'https://local.example/x',
        normalizedUrl: 'https://local.example/x',
        tags: [],
        order: 0,
      },
    ]);

    const engine = new SyncEngine();
    const res = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree,
      snapshot: null,
      syncMode: 'subscribe-only',
    });

    expect(commitSpy).not.toHaveBeenCalled();
    expect(res.committed).toBe(false);
    expect(res.remoteCommitNeeded).toBe(false);
    expect(res.localPatchNeeded).toBe(true);
    expect(res.browserTargetTree.root.bookmarks.map((b) => b.url)).toEqual([
      'https://example.org/a',
    ]);
  });

  it('propose-pr pushes contributor annotations and opens a PR without touching base branch', async () => {
    let capturedProposal: ProposeChangesInput | undefined;
    const remoteMd = [
      '---',
      'title: Team Bookmarks',
      'order: 0',
      '---',
      '',
      '- [Existing](https://example.org/one) <!-- glyphrig: added=2026-11-01 by=alice -->',
      '  - **@alice**: Original note',
      '',
    ].join('\n');

    const adapter: ForgeAdapter = {
      kind: 'github',
      getAuthenticatedUser: async () => ({ username: 'bob' }),
      testConnection: async () => ({
        forge: 'github',
        fullName: 'org/garden',
        defaultBranch: 'main',
        branchExists: true,
        headSha: 'base123',
        private: false,
      }),
      getHeadSha: async () => 'base123',
      readBookmarkFiles: async () => ({
        commitSha: 'base123',
        files: new Map([['bookmarks/README.md', remoteMd]]),
        fileShas: new Map([['bookmarks/README.md', 'blob1']]),
      }),
      commitChanges: async () => {
        throw new Error('commitChanges should not be called in propose-pr mode');
      },
      proposeChanges: async (input) => {
        capturedProposal = input;
        return {
          commitSha: 'prcommit999',
          proposalBranch: input.proposalBranch,
          prUrl: 'https://github.com/org/garden/pull/42',
          prNumber: 42,
          updatedExisting: false,
        };
      },
    };

    const localTree = makeTree([
      {
        title: 'Existing',
        url: 'https://example.org/one',
        normalizedUrl: 'https://example.org/one',
        tags: [],
        order: 0,
      },
      {
        title: 'Rust Docs',
        url: 'https://docs.rs/tokio',
        normalizedUrl: 'https://docs.rs/tokio',
        tags: [],
        order: 1,
      },
    ]);

    const engine = new SyncEngine();
    const res = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree,
      snapshot: null,
      syncMode: 'propose-pr',
      currentUser: 'bob',
      autoTagRules: [{ match: 'docs.rs/**', tags: ['rust', 'docs'] }],
      localAnnotations: [
        {
          url: 'https://example.org/one',
          normalizedUrl: 'https://example.org/one',
          contributorNote: 'Also helpful for onboarding',
          tags: ['team'],
          updatedAt: '2026-11-25T00:00:00Z',
        },
      ],
    });

    expect(res.committed).toBe(true);
    expect(res.pullRequestUrl).toBe('https://github.com/org/garden/pull/42');
    expect(res.pullRequestNumber).toBe(42);
    expect(capturedProposal?.proposalBranch).toBe('glyphrig/bob');
    const updatedMd = capturedProposal?.upserts.get('bookmarks/README.md') ?? '';
    expect(updatedMd).toContain('  - **@alice**: Original note');
    expect(updatedMd).toContain('  - **@bob**: Also helpful for onboarding');
    expect(updatedMd).toContain('`#rust` `#docs`');
    expect(updatedMd).toContain('by=alice,bob');
  });

  it('GitHubAdapter omits Authorization header when token is empty for anonymous reads', async () => {
    const seenHeaders: Array<HeadersInit | undefined> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      seenHeaders.push(init?.headers);
      const url = String(input);
      if (url.endsWith('/git/ref/heads/main')) {
        return new Response(JSON.stringify({ object: { sha: 'abc' } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const adapter = new GitHubAdapter({
      forge: 'github',
      owner: 'org',
      repo: 'public-garden',
      token: '',
      fetchFn: mockFetch,
    });

    const sha = await adapter.getHeadSha('main');
    expect(sha).toBe('abc');
    expect((seenHeaders[0] as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('auto-tag rules and invite codec', () => {
  it('matches host globs, path globs, and regex rules cleanly', () => {
    const rules = [
      { match: '*.arxiv.org', tags: ['papers', 'research'] },
      { match: 'github.com/*/*', tags: ['oss'] },
      { match: '/youtube\\.com\\/watch/i', tags: ['video'] },
    ];

    expect(
      applyAutoTagRules({ url: 'https://arxiv.org/abs/2501.00001', tags: ['ml'] }, rules),
    ).toEqual(['ml', 'papers', 'research']);

    expect(
      applyAutoTagRules({ url: 'https://github.com/Glyphrig/Glyphrig', tags: [] }, rules),
    ).toEqual(['oss']);

    expect(
      applyAutoTagRules({ url: 'https://www.youtube.com/watch?v=123', tags: [] }, rules),
    ).toEqual(['video']);
  });

  it('round-trips invite codes and builds suggest-bookmark issue URLs', () => {
    const manifest = {
      version: 1 as const,
      title: 'Tekromancy Garden',
      forge: 'github' as const,
      owner: 'tekromancy',
      repo: 'bookmarks',
      branch: 'main',
      rootDir: 'bookmarks',
      siteUrl: 'https://tekromancy.github.io/bookmarks/',
      recommendedSyncMode: 'subscribe-only' as const,
    };

    const code = encodeGlyphrigInvite(manifest);
    expect(code.startsWith('glyphrig-invite:')).toBe(true);
    expect(decodeGlyphrigInvite(code)).toEqual(manifest);

    const deepLink = decodeGlyphrigInvite(
      'glyphrig://join?forge=github&owner=tekromancy&repo=bookmarks&mode=propose-pr',
    );
    expect(deepLink?.owner).toBe('tekromancy');
    expect(deepLink?.recommendedSyncMode).toBe('propose-pr');

    const suggestUrl = buildSuggestBookmarkUrl(manifest, {
      title: 'Example',
      url: 'https://example.com',
      folderPath: 'tools',
      note: 'Handy tool',
      tags: ['dev'],
    });
    expect(suggestUrl).toContain('https://github.com/tekromancy/bookmarks/issues/new?');
    expect(decodeURIComponent(suggestUrl)).toContain('bookmarks/tools/README.md');
  });
});

describe('bug-hunt regressions (merge, safety, parser, slugs, propose-pr)', () => {
  it('propagates remote deletions of tagged/noted bookmarks without resurrecting them from browser tree', async () => {
    const initialRemoteMd = [
      '---',
      'title: Team Bookmarks',
      'order: 0',
      '---',
      '',
      '- [Keep Me](https://example.org/keep) — Core link `#rust` <!-- glyphrig: added=2026-11-01 by=alice -->',
      '  - **@alice**: Keep note',
      '- [Delete Me](https://example.org/del) — Old link `#legacy` <!-- glyphrig: added=2026-11-01 by=alice -->',
      '  - **@alice**: Old note',
      '',
    ].join('\n');

    const updatedRemoteMd = [
      '---',
      'title: Team Bookmarks',
      'order: 0',
      '---',
      '',
      '- [Keep Me](https://example.org/keep) — Core link `#rust` <!-- glyphrig: added=2026-11-01 by=alice -->',
      '  - **@alice**: Keep note',
      '',
    ].join('\n');

    let remoteMd = initialRemoteMd;
    let headSha = 'sha1';
    const commitSpy = vi.fn(async () => ({ commitSha: 'sha-pushed' }));

    const adapter: ForgeAdapter = {
      kind: 'github',
      getAuthenticatedUser: async () => ({ username: 'bob' }),
      testConnection: async () => ({
        forge: 'github',
        fullName: 'org/garden',
        defaultBranch: 'main',
        branchExists: true,
        headSha,
        private: false,
      }),
      getHeadSha: async () => headSha,
      readBookmarkFiles: async () => ({
        commitSha: headSha,
        files: new Map([['bookmarks/README.md', remoteMd]]),
        fileShas: new Map([['bookmarks/README.md', 'b1']]),
      }),
      commitChanges: commitSpy,
    };

    const browserTree = makeTree([
      {
        title: 'Keep Me',
        url: 'https://example.org/keep',
        normalizedUrl: 'https://example.org/keep',
        tags: [],
        order: 0,
      },
      {
        title: 'Delete Me',
        url: 'https://example.org/del',
        normalizedUrl: 'https://example.org/del',
        tags: [],
        order: 1,
      },
    ]);

    const engine = new SyncEngine();
    const first = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree: browserTree,
      snapshot: null,
      syncMode: 'two-way',
      currentUser: 'bob',
    });

    // Sync 1 should NOT mark bob as editor or commit untouched tagged/noted links
    expect(first.conflicts).toHaveLength(0);

    // Remote teammate deletes "Delete Me"
    remoteMd = updatedRemoteMd;
    headSha = 'sha2';
    commitSpy.mockClear();

    const second = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree: browserTree,
      snapshot: first.snapshot,
      syncMode: 'two-way',
      currentUser: 'bob',
    });

    expect(second.conflicts).toHaveLength(0);
    expect(commitSpy).not.toHaveBeenCalled();
    expect(second.localPatchNeeded).toBe(true);
    expect(second.browserTargetTree.root.bookmarks.map((b) => b.url)).toEqual([
      'https://example.org/keep',
    ]);
  });

  it('propose-pr Sync 2 preserves Sync 1 unmerged PR bookmarks and records lastRemoteTree', async () => {
    const proposals: ProposeChangesInput[] = [];
    const remoteMd = [
      '---',
      'title: Team Bookmarks',
      'order: 0',
      '---',
      '',
      '- [Remote Only](https://example.org/remote) `#team` <!-- glyphrig: added=2026-11-01 by=alice -->',
      '',
    ].join('\n');

    const adapter: ForgeAdapter = {
      kind: 'github',
      getAuthenticatedUser: async () => ({ username: 'bob' }),
      testConnection: async () => ({
        forge: 'github',
        fullName: 'org/garden',
        defaultBranch: 'main',
        branchExists: true,
        headSha: 'base1',
        private: false,
      }),
      getHeadSha: async () => 'base1',
      readBookmarkFiles: async () => ({
        commitSha: 'base1',
        files: new Map([['bookmarks/README.md', remoteMd]]),
        fileShas: new Map([['bookmarks/README.md', 'b1']]),
      }),
      commitChanges: async () => {
        throw new Error('Should not commit directly');
      },
      proposeChanges: async (input) => {
        proposals.push(input);
        return {
          commitSha: `pr-${proposals.length}`,
          proposalBranch: input.proposalBranch,
          prUrl: 'https://github.com/org/garden/pull/7',
          prNumber: 7,
          updatedExisting: proposals.length > 1,
        };
      },
    };

    const engine = new SyncEngine();
    const sync1 = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree: makeTree([
        {
          title: 'PR Link 1',
          url: 'https://example.org/pr1',
          normalizedUrl: 'https://example.org/pr1',
          tags: [],
          order: 0,
        },
      ]),
      snapshot: null,
      syncMode: 'propose-pr',
      currentUser: 'bob',
    });

    expect(sync1.snapshot.lastRemoteTree?.root.bookmarks.map((b) => b.url)).toEqual([
      'https://example.org/remote',
      'https://example.org/pr1',
    ]);

    // Before PR #7 is merged, bob adds a second link and syncs again
    await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree: makeTree([
        {
          title: 'PR Link 1',
          url: 'https://example.org/pr1',
          normalizedUrl: 'https://example.org/pr1',
          tags: [],
          order: 0,
        },
        {
          title: 'PR Link 2',
          url: 'https://example.org/pr2',
          normalizedUrl: 'https://example.org/pr2',
          tags: [],
          order: 1,
        },
      ]),
      snapshot: sync1.snapshot,
      syncMode: 'propose-pr',
      currentUser: 'bob',
    });

    const md2 = proposals[1]?.upserts.get('bookmarks/README.md') ?? '';
    expect(md2).toContain('https://example.org/remote');
    expect(md2).toContain('https://example.org/pr1');
    expect(md2).toContain('https://example.org/pr2');
  });

  it('preserves safety-skipped private bookmarks in browserTargetTree while omitting them from Git', async () => {
    const pushedFiles = new Map<string, string>();
    const adapter: ForgeAdapter = {
      kind: 'github',
      getAuthenticatedUser: async () => ({ username: 'alice' }),
      testConnection: async () => ({
        forge: 'github',
        fullName: 'org/garden',
        defaultBranch: 'main',
        branchExists: true,
        headSha: 'sha1',
        private: false,
      }),
      getHeadSha: async () => 'sha1',
      readBookmarkFiles: async () => ({
        commitSha: 'sha1',
        files: new Map([
          [
            'bookmarks/README.md',
            '---\ntitle: Team Bookmarks\norder: 0\n---\n\n- [Remote](https://example.org/r)\n',
          ],
        ]),
        fileShas: new Map([['bookmarks/README.md', 'b1']]),
      }),
      commitChanges: async (input) => {
        for (const [k, v] of input.upserts) pushedFiles.set(k, v);
        return { commitSha: 'sha2' };
      },
    };

    const engine = new SyncEngine();
    const res = await engine.sync({
      adapter,
      branch: 'main',
      rootDir: 'bookmarks',
      localTree: makeTree([
        {
          title: 'Local Dev App',
          url: 'http://localhost:3000/dashboard',
          normalizedUrl: 'http://localhost:3000/dashboard',
          tags: [],
          order: 0,
        },
        {
          title: 'Public Site',
          url: 'https://public.example.org/doc',
          normalizedUrl: 'https://public.example.org/doc',
          tags: [],
          order: 1,
        },
      ]),
      snapshot: null,
      syncMode: 'two-way',
      currentUser: 'alice',
    });

    expect(res.skipped).toHaveLength(1);
    expect(pushedFiles.get('bookmarks/README.md')).not.toContain('localhost');
    // Browser target tree MUST retain the skipped localhost bookmark so browser sync doesn't delete it!
    expect(res.browserTargetTree.root.bookmarks.map((b) => b.url)).toContain(
      'http://localhost:3000/dashboard',
    );
  });

  it('handles public IPv6, OAuth hash tokens, glob ** paths, slug collisions, and CommonMark inline code', () => {
    expect(inspectUrlSafety('https://[2606:4700:4700::1111]/dns').allowed).toBe(true);
    expect(inspectUrlSafety('https://app.example.com/cb#access_token=supersecret').allowed).toBe(
      false,
    );

    expect(
      applyAutoTagRules(
        { url: 'https://docs.rs/Tokio/latest/tokio/io/index.html', tags: ['async'] },
        [{ match: 'docs.rs/**', tags: ['rust', 'docs'] }],
      ),
    ).toEqual(['async', 'rust', 'docs']);

    expect(assignSiblingSlugs(['Tools', 'Tools!', 'Tools 2'])).toEqual([
      'tools',
      'tools-2',
      'tools-2-2',
    ]);

    const md = [
      '---',
      'title: Notes',
      'order: 0',
      '---',
      '',
      'Run ```glyphrig build``` before deploy.',
      '',
      '- [First](https://example.org/1)',
      '  - **Note**: Plain bold bullet should not become contributor @note',
      '  - **@alice**: Actual contributor note',
      '',
    ].join('\n');
    const parsed = parseFolderMarkdown(md, 'notes');
    expect(parsed.bookmarks).toHaveLength(1);
    expect(parsed.bookmarks[0]?.contributorNotes).toEqual({
      alice: 'Actual contributor note',
    });
  });
});
