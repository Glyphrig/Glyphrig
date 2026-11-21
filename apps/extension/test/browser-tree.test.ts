import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {},
}));

import { normalizeUrl, type BookmarkTree } from '@glyphrig/core';
import {
  applyTreeToBrowser,
  isDescendantOfFolder,
  listSelectableFolders,
  readBrowserSubtree,
  type BookmarksApi,
  type BrowserBookmarkNode,
} from '../src/lib/browser-tree.js';

function createMemoryBookmarksApi(initial: BrowserBookmarkNode[]): BookmarksApi {
  let nextId = 100;
  const byId = new Map<string, BrowserBookmarkNode>();

  function index(node: BrowserBookmarkNode, parentId?: string): void {
    node.parentId = parentId;
    byId.set(node.id, node);
    if (node.children) {
      node.children.forEach((c, i) => {
        c.index = i;
        index(c, node.id);
      });
    }
  }
  initial.forEach((r) => index(r, undefined));

  function clone(node: BrowserBookmarkNode): BrowserBookmarkNode {
    return {
      ...node,
      ...(node.children ? { children: node.children.map(clone) } : {}),
    };
  }

  return {
    async getTree() {
      return initial.map(clone);
    },
    async getSubTree(id) {
      const n = byId.get(id);
      return n ? [clone(n)] : [];
    },
    async getChildren(id) {
      const n = byId.get(id);
      return (n?.children ?? []).map(clone);
    },
    async get(id) {
      const n = byId.get(id);
      return n ? [clone(n)] : [];
    },
    async create(input) {
      const parent = byId.get(input.parentId ?? '1');
      if (!parent) throw new Error('Parent not found');
      parent.children ??= [];
      const created: BrowserBookmarkNode = {
        id: String(nextId++),
        parentId: parent.id,
        title: input.title ?? '',
        ...(input.url !== undefined ? { url: input.url } : { children: [] }),
        dateAdded: Date.UTC(2026, 10, 21),
      };
      const idx = input.index ?? parent.children.length;
      parent.children.splice(idx, 0, created);
      byId.set(created.id, created);
      return clone(created);
    },
    async update(id, changes) {
      const n = byId.get(id);
      if (!n) throw new Error('Not found');
      if (changes.title !== undefined) n.title = changes.title;
      if (changes.url !== undefined) n.url = changes.url;
      return clone(n);
    },
    async move(id, dest) {
      const n = byId.get(id);
      if (!n || !n.parentId) throw new Error('Not found');
      const oldParent = byId.get(n.parentId);
      const newParent = byId.get(dest.parentId ?? n.parentId);
      if (!oldParent?.children || !newParent) throw new Error('Parent missing');
      oldParent.children = oldParent.children.filter((c) => c.id !== id);
      newParent.children ??= [];
      const targetIdx = dest.index ?? newParent.children.length;
      newParent.children.splice(targetIdx, 0, n);
      n.parentId = newParent.id;
      return clone(n);
    },
    async remove(id) {
      const n = byId.get(id);
      if (!n?.parentId) return;
      const p = byId.get(n.parentId);
      if (p?.children) p.children = p.children.filter((c) => c.id !== id);
      byId.delete(id);
    },
    async removeTree(id) {
      const n = byId.get(id);
      if (!n?.parentId) return;
      const p = byId.get(n.parentId);
      if (p?.children) p.children = p.children.filter((c) => c.id !== id);
      function delRec(cur: BrowserBookmarkNode): void {
        byId.delete(cur.id);
        cur.children?.forEach(delRec);
      }
      delRec(n);
    },
  };
}

describe('browser bookmark tree adapter', () => {
  it('marks Chrome and Firefox root containers non-selectable while allowing subfolders', async () => {
    const chromeApi = createMemoryBookmarksApi([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              { id: '10', title: 'Public Bookmarks', children: [] },
            ],
          },
          { id: '2', title: 'Other Bookmarks', children: [] },
        ],
      },
    ]);

    const chromeFolders = await listSelectableFolders(chromeApi);
    expect(chromeFolders.find((f) => f.id === '1')?.selectable).toBe(false);
    expect(chromeFolders.find((f) => f.id === '2')?.selectable).toBe(false);
    expect(chromeFolders.find((f) => f.id === '10')?.selectable).toBe(true);

    const firefoxApi = createMemoryBookmarksApi([
      {
        id: 'root________',
        title: '',
        children: [
          {
            id: 'toolbar_____',
            title: 'Bookmarks Toolbar',
            children: [
              { id: 'folder-abc', title: 'Shared Links', children: [] },
            ],
          },
          { id: 'mobile______', title: 'Mobile Bookmarks', children: [] },
        ],
      },
    ]);

    const ffFolders = await listSelectableFolders(firefoxApi);
    expect(ffFolders.find((f) => f.id === 'toolbar_____')?.selectable).toBe(false);
    expect(ffFolders.find((f) => f.id === 'mobile______')?.selectable).toBe(false);
    expect(ffFolders.find((f) => f.id === 'folder-abc')?.selectable).toBe(true);
  });

  it('reads browser subtree ignoring Firefox separators and checks descendant ancestry', async () => {
    const api = createMemoryBookmarksApi([
      {
        id: 'root________',
        title: '',
        children: [
          {
            id: 'toolbar_____',
            title: 'Bookmarks Toolbar',
            children: [
              {
                id: 'pub',
                title: 'Public',
                children: [
                  { id: 'sep1', title: '', type: 'separator' },
                  {
                    id: 'bm1',
                    title: 'Astro',
                    url: 'https://astro.build',
                    dateAdded: Date.UTC(2026, 10, 21),
                  },
                  {
                    id: 'sub1',
                    title: 'Dev Tools',
                    children: [
                      {
                        id: 'bm2',
                        title: 'WXT',
                        url: 'https://wxt.dev',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const tree = await readBrowserSubtree('pub', api);
    expect(tree.root.title).toBe('Public');
    expect(tree.root.bookmarks).toHaveLength(1);
    expect(tree.root.bookmarks[0]?.added).toBe('2026-11-21');
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0]?.path).toBe('dev-tools');
    expect(tree.root.children[0]?.bookmarks[0]?.url).toBe('https://wxt.dev');

    expect(await isDescendantOfFolder('bm2', 'pub', api)).toBe(true);
    expect(await isDescendantOfFolder('toolbar_____', 'pub', api)).toBe(false);
  });

  it('applies merged tree changes inside echo-suppression hooks cleanly', async () => {
    const api = createMemoryBookmarksApi([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              {
                id: 'pub',
                title: 'Public',
                children: [
                  { id: 'old-bm', title: 'Old', url: 'https://old.example.org' },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const events: string[] = [];
    const target: BookmarkTree = {
      root: {
        path: '',
        slug: '',
        title: 'Public',
        order: 0,
        bookmarks: [
          {
            title: 'Astro',
            url: 'https://astro.build',
            normalizedUrl: normalizeUrl('https://astro.build'),
            tags: [],
            order: 0,
          },
        ],
        children: [
          {
            path: 'reading',
            slug: 'reading',
            title: 'Reading',
            order: 0,
            bookmarks: [
              {
                title: 'MDN',
                url: 'https://developer.mozilla.org',
                normalizedUrl: normalizeUrl('https://developer.mozilla.org'),
                tags: [],
                order: 0,
              },
            ],
            children: [],
          },
        ],
      },
    };

    await applyTreeToBrowser(
      'pub',
      target,
      {
        onStart: () => {
          events.push('start');
        },
        onEnd: () => {
          events.push('end');
        },
      },
      api,
    );

    expect(events).toEqual(['start', 'end']);
    const after = await readBrowserSubtree('pub', api);
    expect(after.root.bookmarks.map((b) => b.url)).toEqual(['https://astro.build']);
    expect(after.root.children[0]?.title).toBe('Reading');
    expect(after.root.children[0]?.bookmarks.map((b) => b.url)).toEqual([
      'https://developer.mozilla.org',
    ]);
  });
});
