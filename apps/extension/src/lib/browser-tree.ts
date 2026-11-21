import {
  assignSiblingSlugs,
  normalizeUrl,
  slugifyFolderName,
  type BookmarkEntry,
  type BookmarkTree,
  type FolderNode,
} from '@glyphrig/core';
import { browser } from 'wxt/browser';
import type { SelectableFolderNode } from './messages.js';

export interface BrowserBookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded?: number;
  type?: 'bookmark' | 'folder' | 'separator';
  children?: BrowserBookmarkNode[];
}

export interface BookmarksApi {
  getTree(): Promise<BrowserBookmarkNode[]>;
  getSubTree(id: string): Promise<BrowserBookmarkNode[]>;
  getChildren(id: string): Promise<BrowserBookmarkNode[]>;
  get(idOrIdList: string): Promise<BrowserBookmarkNode[]>;
  create(bookmark: {
    parentId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<BrowserBookmarkNode>;
  update(
    id: string,
    changes: { title?: string; url?: string },
  ): Promise<BrowserBookmarkNode>;
  move(
    id: string,
    destination: { parentId?: string; index?: number },
  ): Promise<BrowserBookmarkNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
}

const NON_SELECTABLE_ROOT_IDS = new Set([
  '0',
  '1',
  '2',
  '3',
  'root________',
  'toolbar_____',
  'menu________',
  'unfiled_____',
  'mobile______',
]);

function defaultApi(): BookmarksApi {
  return browser.bookmarks as unknown as BookmarksApi;
}

export function isBrowserRootContainer(node: Pick<BrowserBookmarkNode, 'id' | 'parentId'>): boolean {
  if (!node.parentId) return true;
  return NON_SELECTABLE_ROOT_IDS.has(node.id);
}

export async function listSelectableFolders(
  api: BookmarksApi = defaultApi(),
): Promise<SelectableFolderNode[]> {
  const tree = await api.getTree();
  const out: SelectableFolderNode[] = [];

  function walk(node: BrowserBookmarkNode, depth: number): void {
    if (node.url !== undefined || node.type === 'separator') {
      return;
    }
    const children = node.children ?? [];
    if (node.parentId) {
      out.push({
        id: node.id,
        title: node.title || '(Untitled Folder)',
        depth,
        selectable: !isBrowserRootContainer(node),
        childCount: children.filter((c) => c.type !== 'separator').length,
      });
    }
    for (const child of children) {
      walk(child, node.parentId ? depth + 1 : depth);
    }
  }

  for (const root of tree) {
    walk(root, 0);
  }
  return out;
}

export async function isDescendantOfFolder(
  nodeId: string,
  ancestorFolderId: string,
  api: BookmarksApi = defaultApi(),
): Promise<boolean> {
  if (nodeId === ancestorFolderId) return true;
  let currentId: string | undefined = nodeId;
  let hops = 0;

  while (currentId && hops < 64) {
    hops++;
    if (currentId === ancestorFolderId) return true;
    try {
      const nodes = await api.get(currentId);
      const first = nodes[0];
      if (!first) return false;
      currentId = first.parentId;
    } catch {
      return false;
    }
  }
  return false;
}

function formatAddedDate(dateAdded?: number): string | undefined {
  if (!dateAdded || !Number.isFinite(dateAdded)) {
    return undefined;
  }
  const d = new Date(dateAdded);
  if (Number.isNaN(d.getTime())) {
    return undefined;
  }
  return d.toISOString().slice(0, 10);
}

export async function readBrowserSubtree(
  rootFolderId: string,
  api: BookmarksApi = defaultApi(),
): Promise<BookmarkTree> {
  const res = await api.getSubTree(rootFolderId);
  const rootNode = res[0];
  if (!rootNode || rootNode.url !== undefined) {
    throw new Error(`Selected bookmark folder (${rootFolderId}) was not found.`);
  }

  function convertFolder(
    node: BrowserBookmarkNode,
    folderPath: string,
    slug: string,
    order: number,
  ): FolderNode {
    const rawChildren = (node.children ?? []).filter(
      (c) => c.type !== 'separator',
    );
    const childBookmarks = rawChildren.filter((c) => c.url !== undefined);
    const childFolders = rawChildren.filter((c) => c.url === undefined);

    const bookmarks: BookmarkEntry[] = childBookmarks.map((b, idx) => {
      const added = formatAddedDate(b.dateAdded);
      const url = (b.url ?? '').trim();
      return {
        title: (b.title || url).trim(),
        url,
        normalizedUrl: normalizeUrl(url, false),
        ...(added ? { added } : {}),
        tags: [],
        order: idx,
      };
    });

    const childSlugs = assignSiblingSlugs(childFolders.map((f) => f.title || 'Folder'));
    const children: FolderNode[] = childFolders.map((cf, idx) => {
      const cSlug = childSlugs[idx] ?? 'folder';
      const cPath = folderPath ? `${folderPath}/${cSlug}` : cSlug;
      return convertFolder(cf, cPath, cSlug, idx);
    });

    return {
      path: folderPath,
      slug,
      title: node.title || 'Bookmarks',
      order,
      bookmarks,
      children,
    };
  }

  return {
    root: convertFolder(rootNode, '', '', 0),
  };
}

export interface ApplyHooks {
  onStart: () => void | Promise<void>;
  onEnd: () => void | Promise<void>;
}

export async function applyTreeToBrowser(
  rootFolderId: string,
  targetTree: BookmarkTree,
  hooks: ApplyHooks,
  api: BookmarksApi = defaultApi(),
): Promise<void> {
  await hooks.onStart();
  try {
    async function reconcileFolder(
      browserFolderId: string,
      targetFolder: FolderNode,
    ): Promise<void> {
      const children = (await api.getChildren(browserFolderId)).filter(
        (c) => c.type !== 'separator',
      );
      const existingBookmarks = children.filter((c) => c.url !== undefined);
      const existingFolders = children.filter((c) => c.url === undefined);

      // Index existing folders by slugified title (queue for collisions)
      const folderBySlug = new Map<string, BrowserBookmarkNode[]>();
      for (const ef of existingFolders) {
        const s = slugifyFolderName(ef.title || 'Folder');
        const list = folderBySlug.get(s) ?? [];
        list.push(ef);
        folderBySlug.set(s, list);
      }

      // Match existing bookmarks by normalizedUrl
      const bmByNormUrl = new Map<string, BrowserBookmarkNode[]>();
      for (const eb of existingBookmarks) {
        const norm = normalizeUrl(eb.url ?? '', false);
        const list = bmByNormUrl.get(norm) ?? [];
        list.push(eb);
        bmByNormUrl.set(norm, list);
      }

      // Reconcile bookmarks (placed first, followed by subfolders)
      const desiredBookmarks = [...targetFolder.bookmarks].sort(
        (a, b) => a.order - b.order,
      );
      const keptBookmarkIds = new Set<string>();
      const orderedTargetItems: Array<{ id: string; isFolder: boolean }> = [];

      for (const targetBm of desiredBookmarks) {
        const norm = normalizeUrl(targetBm.url, false);
        const candidates = bmByNormUrl.get(norm);
        const matched =
          candidates && candidates.length > 0 ? candidates.shift() : undefined;

        if (matched) {
          keptBookmarkIds.add(matched.id);
          if (matched.title !== targetBm.title || matched.url !== targetBm.url) {
            await api.update(matched.id, {
              title: targetBm.title,
              url: targetBm.url,
            });
          }
          orderedTargetItems.push({ id: matched.id, isFolder: false });
        } else {
          const created = await api.create({
            parentId: browserFolderId,
            title: targetBm.title,
            url: targetBm.url,
          });
          keptBookmarkIds.add(created.id);
          orderedTargetItems.push({ id: created.id, isFolder: false });
        }
      }

      for (const eb of existingBookmarks) {
        if (!keptBookmarkIds.has(eb.id)) {
          await api.remove(eb.id);
        }
      }

      // Reconcile child folders
      const desiredFolders = [...targetFolder.children].sort(
        (a, b) => a.order - b.order || a.slug.localeCompare(b.slug),
      );
      const keptFolderIds = new Set<string>();
      const folderRecursePairs: Array<{ id: string; node: FolderNode }> = [];

      for (const targetChild of desiredFolders) {
        // Prefer exact slug base match; strip collision suffix -2/-3 if needed
        const candidates =
          folderBySlug.get(targetChild.slug) ??
          folderBySlug.get(slugifyFolderName(targetChild.title));
        const matched =
          candidates && candidates.length > 0 ? candidates.shift() : undefined;

        if (matched) {
          keptFolderIds.add(matched.id);
          if (matched.title !== targetChild.title) {
            await api.update(matched.id, { title: targetChild.title });
          }
          orderedTargetItems.push({ id: matched.id, isFolder: true });
          folderRecursePairs.push({ id: matched.id, node: targetChild });
        } else {
          const created = await api.create({
            parentId: browserFolderId,
            title: targetChild.title,
          });
          keptFolderIds.add(created.id);
          orderedTargetItems.push({ id: created.id, isFolder: true });
          folderRecursePairs.push({ id: created.id, node: targetChild });
        }
      }

      for (const ef of existingFolders) {
        if (!keptFolderIds.has(ef.id)) {
          await api.removeTree(ef.id);
        }
      }

      // Ensure stable order matching targetTree
      for (let i = 0; i < orderedTargetItems.length; i++) {
        const item = orderedTargetItems[i]!;
        const currentChildren = (await api.getChildren(browserFolderId)).filter(
          (c) => c.type !== 'separator',
        );
        const currentIdx = currentChildren.findIndex((c) => c.id === item.id);
        if (currentIdx !== -1 && currentIdx !== i) {
          await api.move(item.id, { parentId: browserFolderId, index: i });
        }
      }

      for (const pair of folderRecursePairs) {
        await reconcileFolder(pair.id, pair.node);
      }
    }

    await reconcileFolder(rootFolderId, targetTree.root);
  } finally {
    await hooks.onEnd();
  }
}
