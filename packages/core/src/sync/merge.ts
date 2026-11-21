import { generateId } from '../forge/encoding.js';
import type {
  BookmarkEntry,
  BookmarkTree,
  ConflictRecord,
  FolderNode,
  SyncDiffSummary,
} from '../types.js';
import {
  collectFoldersMap,
  computeTreeDelta,
  flattenBookmarks,
  summarizeBrowserChanges,
  summarizeRepoChanges,
  type BookmarkItemRef,
} from './diff.js';

export interface ThreeWayMergeResult {
  merged: BookmarkTree;
  conflicts: ConflictRecord[];
  localPatchNeeded: boolean;
  summary: SyncDiffSummary;
}

function makeConflict(
  partial: Omit<ConflictRecord, 'id' | 'timestamp'>,
): ConflictRecord {
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

function carryOverRichMetadata(
  preferred: BookmarkEntry,
  fallback?: BookmarkEntry,
): BookmarkEntry {
  if (!fallback) {
    return { ...preferred, tags: [...preferred.tags] };
  }
  return {
    ...preferred,
    note: preferred.note !== undefined ? preferred.note : fallback.note,
    tags: preferred.tags.length > 0 ? [...preferred.tags] : [...fallback.tags],
    added: preferred.added !== undefined ? preferred.added : fallback.added,
  };
}

function defaultTitleFromPath(folderPath: string): string {
  if (!folderPath) return 'Bookmarks';
  const slug = folderPath.split('/').pop() ?? folderPath;
  return slug
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function areBrowserVisibleEqual(a: BookmarkTree, b: BookmarkTree): boolean {
  function normFolder(folder: FolderNode): unknown {
    return {
      path: folder.path,
      title: folder.title,
      bookmarks: [...folder.bookmarks]
        .sort((x, y) => x.order - y.order)
        .map((bm) => ({ title: bm.title, url: bm.url })),
      children: [...folder.children]
        .sort((x, y) => x.order - y.order || x.slug.localeCompare(y.slug))
        .map(normFolder),
    };
  }
  return JSON.stringify(normFolder(a.root)) === JSON.stringify(normFolder(b.root));
}

function buildMergedFolderTree(
  allFolderPaths: Set<string>,
  folderBookmarks: Map<string, BookmarkEntry[]>,
  baseFolders: Map<string, FolderNode>,
  localFolders: Map<string, FolderNode>,
  remoteFolders: Map<string, FolderNode>,
  conflicts: ConflictRecord[],
  isInitialUnion: boolean,
): BookmarkTree {
  // Ensure every folder holding bookmarks also includes all ancestor folders
  const requiredByContent = new Set<string>(['']);
  for (const [path, list] of folderBookmarks.entries()) {
    if (list.length === 0) continue;
    let cur = path;
    while (cur) {
      requiredByContent.add(cur);
      const idx = cur.lastIndexOf('/');
      cur = idx === -1 ? '' : cur.slice(0, idx);
    }
  }

  // Decide which empty folders survive
  const keptPaths = new Set<string>(requiredByContent);
  for (const path of allFolderPaths) {
    if (!path || keptPaths.has(path)) continue;
    const inBase = baseFolders.has(path);
    const inLocal = localFolders.has(path);
    const inRemote = remoteFolders.has(path);

    if (isInitialUnion) {
      if (inLocal || inRemote) keptPaths.add(path);
    } else if (!inBase) {
      if (inLocal || inRemote) keptPaths.add(path);
    } else if (inLocal && inRemote) {
      keptPaths.add(path);
    }
  }

  // Ensure ancestors of kept empty folders are kept too
  for (const path of [...keptPaths]) {
    let cur = path;
    while (cur) {
      keptPaths.add(cur);
      const idx = cur.lastIndexOf('/');
      cur = idx === -1 ? '' : cur.slice(0, idx);
    }
  }

  const nodeMap = new Map<string, FolderNode>();

  for (const path of [...keptPaths].sort()) {
    const b = baseFolders.get(path);
    const l = localFolders.get(path);
    const r = remoteFolders.get(path);

    let title = defaultTitleFromPath(path);
    let order = 0;

    if (isInitialUnion) {
      title = r?.title ?? l?.title ?? defaultTitleFromPath(path);
      order = r?.order ?? l?.order ?? 0;
    } else if (b && l && r) {
      const localTitleChanged = l.title !== b.title;
      const remoteTitleChanged = r.title !== b.title;
      if (remoteTitleChanged && localTitleChanged && l.title !== r.title) {
        title = r.title;
        conflicts.push(
          makeConflict({
            folderPath: path,
            url: '',
            kind: 'folder-title-conflict',
            resolution: 'remote-won',
            localSummary: l.title,
            remoteSummary: r.title,
          }),
        );
      } else if (localTitleChanged && !remoteTitleChanged) {
        title = l.title;
      } else {
        title = r.title;
      }

      const localOrderChanged = l.order !== b.order;
      const remoteOrderChanged = r.order !== b.order;
      order = localOrderChanged && !remoteOrderChanged ? l.order : r.order;
    } else {
      title = r?.title ?? l?.title ?? b?.title ?? defaultTitleFromPath(path);
      order = r?.order ?? l?.order ?? b?.order ?? 0;
    }

    const description = r?.description ?? b?.description ?? l?.description;
    const introMarkdown = r?.introMarkdown ?? b?.introMarkdown ?? l?.introMarkdown;
    const rawBookmarks = folderBookmarks.get(path) ?? [];
    const normalizedBookmarks = [...rawBookmarks]
      .sort((a, bItem) => a.order - bItem.order)
      .map((entry, idx) => ({ ...entry, order: idx }));

    const slug = path ? (path.split('/').pop() ?? path) : '';
    nodeMap.set(path, {
      path,
      slug,
      title,
      order,
      ...(description !== undefined ? { description } : {}),
      ...(introMarkdown !== undefined ? { introMarkdown } : {}),
      bookmarks: normalizedBookmarks,
      children: [],
    });
  }

  for (const [path, node] of nodeMap.entries()) {
    if (!path) continue;
    const idx = path.lastIndexOf('/');
    const parentPath = idx === -1 ? '' : path.slice(0, idx);
    const parent = nodeMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    }
  }

  function sortTree(node: FolderNode): void {
    node.children.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.slug.localeCompare(b.slug);
    });
    node.children.forEach((child, idx) => {
      child.order = idx;
      sortTree(child);
    });
  }

  const root = nodeMap.get('')!;
  sortTree(root);
  return { root };
}

export function threeWayMerge(
  base: BookmarkTree | null,
  local: BookmarkTree,
  remote: BookmarkTree,
): ThreeWayMergeResult {
  const conflicts: ConflictRecord[] = [];
  const folderBookmarks = new Map<string, BookmarkEntry[]>();

  const pushBookmark = (folderPath: string, entry: BookmarkEntry): void => {
    const list = folderBookmarks.get(folderPath) ?? [];
    list.push(entry);
    folderBookmarks.set(folderPath, list);
  };

  const localFolders = collectFoldersMap(local);
  const remoteFolders = collectFoldersMap(remote);
  const baseFolders = base ? collectFoldersMap(base) : new Map<string, FolderNode>();

  const allFolderPaths = new Set<string>([
    ...baseFolders.keys(),
    ...localFolders.keys(),
    ...remoteFolders.keys(),
  ]);

  if (!base) {
    // Initial sync: non-destructive union matching by (folderPath, normalizedUrl)
    const remoteItems = flattenBookmarks(remote);
    const localItems = flattenBookmarks(local);

    const remoteByKey = new Map<string, BookmarkItemRef[]>();
    for (const rItem of remoteItems) {
      const key = `${rItem.folderPath}::${rItem.entry.normalizedUrl}`;
      const list = remoteByKey.get(key) ?? [];
      list.push(rItem);
      remoteByKey.set(key, list);
      pushBookmark(rItem.folderPath, { ...rItem.entry, tags: [...rItem.entry.tags] });
    }

    for (const lItem of localItems) {
      const key = `${lItem.folderPath}::${lItem.entry.normalizedUrl}`;
      const existingRemote = remoteByKey.get(key);
      const matched =
        existingRemote && existingRemote.length > 0 ? existingRemote.shift() : undefined;
      if (matched) {
        if (matched.entry.title !== lItem.entry.title) {
          conflicts.push(
            makeConflict({
              folderPath: lItem.folderPath,
              url: lItem.entry.url,
              kind: 'title-conflict',
              resolution: 'remote-won',
              localSummary: lItem.entry.title,
              remoteSummary: matched.entry.title,
            }),
          );
        }
        continue;
      }
      pushBookmark(lItem.folderPath, {
        ...lItem.entry,
        order: (folderBookmarks.get(lItem.folderPath)?.length ?? 0) + 1000 + lItem.entry.order,
        tags: [...lItem.entry.tags],
      });
    }

    const merged = buildMergedFolderTree(
      allFolderPaths,
      folderBookmarks,
      baseFolders,
      localFolders,
      remoteFolders,
      conflicts,
      true,
    );

    return {
      merged,
      conflicts,
      localPatchNeeded: !areBrowserVisibleEqual(local, merged),
      summary: {
        ...summarizeRepoChanges(remote, merged),
        ...summarizeBrowserChanges(local, merged),
      },
    };
  }

  // Full 3-way merge
  const localDelta = computeTreeDelta(base, local);
  const remoteDelta = computeTreeDelta(base, remote);

  for (const [id, baseRef] of localDelta.baseById.entries()) {
    const lStatus = localDelta.baseStates.get(id)!;
    const rStatus = remoteDelta.baseStates.get(id)!;

    if (lStatus.kind === 'deleted' && rStatus.kind === 'deleted') {
      continue;
    }
    if (lStatus.kind === 'deleted' && rStatus.kind === 'unchanged') {
      continue;
    }
    if (rStatus.kind === 'deleted' && lStatus.kind === 'unchanged') {
      continue;
    }

    if (lStatus.kind === 'deleted' && (rStatus.kind === 'edited' || rStatus.kind === 'moved')) {
      conflicts.push(
        makeConflict({
          folderPath: rStatus.targetPath,
          url: rStatus.entry.url,
          kind: 'edit-vs-delete',
          resolution: 'kept-edited',
          localSummary: `Deleted from "${baseRef.folderPath || 'root'}"`,
          remoteSummary: `Modified "${rStatus.entry.title}" in "${rStatus.targetPath || 'root'}"`,
        }),
      );
      pushBookmark(rStatus.targetPath, carryOverRichMetadata(rStatus.entry, baseRef.entry));
      continue;
    }

    if (rStatus.kind === 'deleted' && (lStatus.kind === 'edited' || lStatus.kind === 'moved')) {
      conflicts.push(
        makeConflict({
          folderPath: lStatus.targetPath,
          url: lStatus.entry.url,
          kind: 'edit-vs-delete',
          resolution: 'kept-edited',
          localSummary: `Modified "${lStatus.entry.title}" in "${lStatus.targetPath || 'root'}"`,
          remoteSummary: `Deleted from "${baseRef.folderPath || 'root'}"`,
        }),
      );
      pushBookmark(lStatus.targetPath, carryOverRichMetadata(lStatus.entry, baseRef.entry));
      continue;
    }

    if (lStatus.kind === 'unchanged' && rStatus.kind === 'unchanged') {
      pushBookmark(rStatus.targetPath, carryOverRichMetadata(rStatus.entry, baseRef.entry));
      continue;
    }

    if (lStatus.kind !== 'unchanged' && lStatus.kind !== 'deleted' && rStatus.kind === 'unchanged') {
      // Carry over remote's (unchanged) rich metadata so notes/tags survive moves/renames
      pushBookmark(lStatus.targetPath, carryOverRichMetadata(lStatus.entry, rStatus.entry));
      continue;
    }

    if (lStatus.kind === 'unchanged' && rStatus.kind !== 'unchanged' && rStatus.kind !== 'deleted') {
      pushBookmark(rStatus.targetPath, carryOverRichMetadata(rStatus.entry, baseRef.entry));
      continue;
    }

    // Both local and remote changed the same bookmark
    if (lStatus.kind !== 'deleted' && rStatus.kind !== 'deleted') {
      const converged =
        lStatus.targetPath === rStatus.targetPath &&
        lStatus.entry.title === rStatus.entry.title &&
        lStatus.entry.normalizedUrl === rStatus.entry.normalizedUrl;

      if (!converged) {
        const isMoveConflict = lStatus.targetPath !== rStatus.targetPath;
        conflicts.push(
          makeConflict({
            folderPath: rStatus.targetPath,
            url: rStatus.entry.url,
            kind: isMoveConflict ? 'move-conflict' : 'title-conflict',
            resolution: 'remote-won',
            localSummary: `${lStatus.entry.title} (${lStatus.targetPath || 'root'})`,
            remoteSummary: `${rStatus.entry.title} (${rStatus.targetPath || 'root'})`,
          }),
        );
      }

      pushBookmark(rStatus.targetPath, carryOverRichMetadata(rStatus.entry, baseRef.entry));
    }
  }

  // Merge newly added items from both sides
  const remoteAddMap = new Map<string, BookmarkItemRef[]>();
  for (const rAdd of remoteDelta.unpairedAdds) {
    const key = `${rAdd.folderPath}::${rAdd.entry.normalizedUrl}`;
    const list = remoteAddMap.get(key) ?? [];
    list.push(rAdd);
    remoteAddMap.set(key, list);
    pushBookmark(rAdd.folderPath, { ...rAdd.entry, tags: [...rAdd.entry.tags] });
  }

  for (const lAdd of localDelta.unpairedAdds) {
    const key = `${lAdd.folderPath}::${lAdd.entry.normalizedUrl}`;
    const existingRemote = remoteAddMap.get(key);
    const matched =
      existingRemote && existingRemote.length > 0 ? existingRemote.shift() : undefined;
    if (matched) {
      if (matched.entry.title !== lAdd.entry.title) {
        conflicts.push(
          makeConflict({
            folderPath: lAdd.folderPath,
            url: lAdd.entry.url,
            kind: 'title-conflict',
            resolution: 'remote-won',
            localSummary: lAdd.entry.title,
            remoteSummary: matched.entry.title,
          }),
        );
      }
      continue;
    }
    pushBookmark(lAdd.folderPath, {
      ...lAdd.entry,
      order: (folderBookmarks.get(lAdd.folderPath)?.length ?? 0) + 1000 + lAdd.entry.order,
      tags: [...lAdd.entry.tags],
    });
  }

  const merged = buildMergedFolderTree(
    allFolderPaths,
    folderBookmarks,
    baseFolders,
    localFolders,
    remoteFolders,
    conflicts,
    false,
  );

  return {
    merged,
    conflicts,
    localPatchNeeded: !areBrowserVisibleEqual(local, merged),
    summary: {
      ...summarizeRepoChanges(remote, merged),
      ...summarizeBrowserChanges(local, merged),
    },
  };
}
