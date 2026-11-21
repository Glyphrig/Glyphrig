import type { BookmarkEntry, BookmarkTree, FolderNode, SyncDiffSummary } from '../types.js';

export interface BookmarkItemRef {
  id: string;
  folderPath: string;
  occurrence: number;
  entry: BookmarkEntry;
}

export type BaseItemStatus =
  | { kind: 'unchanged'; targetPath: string; entry: BookmarkEntry }
  | { kind: 'edited'; targetPath: string; entry: BookmarkEntry }
  | { kind: 'moved'; targetPath: string; entry: BookmarkEntry }
  | { kind: 'deleted' };

export interface TreeDelta {
  baseById: Map<string, BookmarkItemRef>;
  baseStates: Map<string, BaseItemStatus>;
  unpairedAdds: BookmarkItemRef[];
}

export function collectFoldersMap(tree: BookmarkTree): Map<string, FolderNode> {
  const map = new Map<string, FolderNode>();
  function walk(folder: FolderNode): void {
    map.set(folder.path, folder);
    for (const child of folder.children) {
      walk(child);
    }
  }
  walk(tree.root);
  return map;
}

export function flattenBookmarks(tree: BookmarkTree): BookmarkItemRef[] {
  const out: BookmarkItemRef[] = [];
  function walk(folder: FolderNode): void {
    const counts = new Map<string, number>();
    const sorted = [...folder.bookmarks].sort((a, b) => a.order - b.order);
    for (const entry of sorted) {
      const occ = counts.get(entry.normalizedUrl) ?? 0;
      counts.set(entry.normalizedUrl, occ + 1);
      out.push({
        id: `${folder.path}::${entry.normalizedUrl}::${occ}`,
        folderPath: folder.path,
        occurrence: occ,
        entry,
      });
    }
    for (const child of folder.children) {
      walk(child);
    }
  }
  walk(tree.root);
  return out;
}

function sameBookmarkFields(a: BookmarkEntry, b: BookmarkEntry): boolean {
  return (
    a.title === b.title &&
    a.normalizedUrl === b.normalizedUrl &&
    a.url === b.url &&
    a.order === b.order &&
    (a.note ?? '') === (b.note ?? '') &&
    a.tags.join(',') === b.tags.join(',')
  );
}

export function computeTreeDelta(base: BookmarkTree, target: BookmarkTree): TreeDelta {
  const baseItems = flattenBookmarks(base);
  const targetItems = flattenBookmarks(target);

  const baseById = new Map<string, BookmarkItemRef>();
  for (const item of baseItems) {
    baseById.set(item.id, item);
  }

  const targetById = new Map<string, BookmarkItemRef>();
  for (const item of targetItems) {
    targetById.set(item.id, item);
  }

  const baseStates = new Map<string, BaseItemStatus>();
  const matchedTargetIds = new Set<string>();
  const unmatchedBase: BookmarkItemRef[] = [];

  // Pass 1: exact (folderPath, normalizedUrl, occurrence) match
  for (const b of baseItems) {
    const t = targetById.get(b.id);
    if (t) {
      matchedTargetIds.add(t.id);
      if (sameBookmarkFields(b.entry, t.entry)) {
        baseStates.set(b.id, {
          kind: 'unchanged',
          targetPath: t.folderPath,
          entry: t.entry,
        });
      } else {
        baseStates.set(b.id, {
          kind: 'edited',
          targetPath: t.folderPath,
          entry: t.entry,
        });
      }
    } else {
      unmatchedBase.push(b);
    }
  }

  const unmatchedTargetByUrl = new Map<string, BookmarkItemRef[]>();
  for (const t of targetItems) {
    if (!matchedTargetIds.has(t.id)) {
      const list = unmatchedTargetByUrl.get(t.entry.normalizedUrl) ?? [];
      list.push(t);
      unmatchedTargetByUrl.set(t.entry.normalizedUrl, list);
    }
  }

  // Pass 2: cross-folder move detection by normalizedUrl
  for (const b of unmatchedBase) {
    const candidates = unmatchedTargetByUrl.get(b.entry.normalizedUrl);
    const movedTarget = candidates && candidates.length > 0 ? candidates.shift() : undefined;
    if (movedTarget) {
      matchedTargetIds.add(movedTarget.id);
      baseStates.set(b.id, {
        kind: 'moved',
        targetPath: movedTarget.folderPath,
        entry: movedTarget.entry,
      });
    } else {
      baseStates.set(b.id, { kind: 'deleted' });
    }
  }

  const unpairedAdds = targetItems.filter((t) => !matchedTargetIds.has(t.id));

  return { baseById, baseStates, unpairedAdds };
}

export function summarizeBrowserChanges(
  local: BookmarkTree,
  merged: BookmarkTree,
): Pick<
  SyncDiffSummary,
  | 'remoteAddedBookmarks'
  | 'remoteRemovedBookmarks'
  | 'remoteUpdatedBookmarks'
  | 'remoteMovedBookmarks'
> {
  const delta = computeTreeDelta(local, merged);
  const remoteAddedBookmarks: SyncDiffSummary['remoteAddedBookmarks'] = [];
  const remoteRemovedBookmarks: SyncDiffSummary['remoteRemovedBookmarks'] = [];
  const remoteUpdatedBookmarks: SyncDiffSummary['remoteUpdatedBookmarks'] = [];
  const remoteMovedBookmarks: SyncDiffSummary['remoteMovedBookmarks'] = [];

  for (const [id, status] of delta.baseStates.entries()) {
    const baseItem = delta.baseById.get(id)!;
    if (status.kind === 'deleted') {
      remoteRemovedBookmarks.push({
        folderPath: baseItem.folderPath,
        title: baseItem.entry.title,
        url: baseItem.entry.url,
      });
    } else if (status.kind === 'moved') {
      remoteMovedBookmarks.push({
        fromPath: baseItem.folderPath,
        toPath: status.targetPath,
        title: status.entry.title,
        url: status.entry.url,
      });
    } else if (
      status.kind === 'edited' &&
      (baseItem.entry.title !== status.entry.title ||
        baseItem.entry.url !== status.entry.url)
    ) {
      remoteUpdatedBookmarks.push({
        folderPath: status.targetPath,
        title: status.entry.title,
        url: status.entry.url,
      });
    }
  }

  for (const add of delta.unpairedAdds) {
    remoteAddedBookmarks.push({
      folderPath: add.folderPath,
      title: add.entry.title,
      url: add.entry.url,
    });
  }

  return {
    remoteAddedBookmarks,
    remoteRemovedBookmarks,
    remoteUpdatedBookmarks,
    remoteMovedBookmarks,
  };
}

export function summarizeRepoChanges(
  remote: BookmarkTree,
  merged: BookmarkTree,
  archivedBookmarks: SyncDiffSummary['archivedBookmarks'] = [],
): Pick<
  SyncDiffSummary,
  | 'addedBookmarks'
  | 'removedBookmarks'
  | 'updatedBookmarks'
  | 'movedBookmarks'
  | 'archivedBookmarks'
  | 'addedFolders'
  | 'removedFolders'
> {
  const delta = computeTreeDelta(remote, merged);
  const addedBookmarks: SyncDiffSummary['addedBookmarks'] = [];
  const removedBookmarks: SyncDiffSummary['removedBookmarks'] = [];
  const updatedBookmarks: SyncDiffSummary['updatedBookmarks'] = [];
  const movedBookmarks: SyncDiffSummary['movedBookmarks'] = [];

  for (const [id, status] of delta.baseStates.entries()) {
    const baseItem = delta.baseById.get(id)!;
    if (status.kind === 'deleted') {
      removedBookmarks.push({
        folderPath: baseItem.folderPath,
        title: baseItem.entry.title,
        url: baseItem.entry.url,
      });
    } else if (status.kind === 'moved') {
      movedBookmarks.push({
        fromPath: baseItem.folderPath,
        toPath: status.targetPath,
        title: status.entry.title,
        url: status.entry.url,
      });
    } else if (status.kind === 'edited') {
      updatedBookmarks.push({
        folderPath: status.targetPath,
        title: status.entry.title,
        url: status.entry.url,
      });
    }
  }

  for (const add of delta.unpairedAdds) {
    addedBookmarks.push({
      folderPath: add.folderPath,
      title: add.entry.title,
      url: add.entry.url,
    });
  }

  const remoteFolders = collectFoldersMap(remote);
  const mergedFolders = collectFoldersMap(merged);
  const addedFolders: string[] = [];
  const removedFolders: string[] = [];

  for (const path of mergedFolders.keys()) {
    if (path && !remoteFolders.has(path)) {
      addedFolders.push(path);
    }
  }
  for (const path of remoteFolders.keys()) {
    if (path && !mergedFolders.has(path)) {
      removedFolders.push(path);
    }
  }

  return {
    addedBookmarks,
    removedBookmarks,
    updatedBookmarks,
    movedBookmarks,
    archivedBookmarks,
    addedFolders: addedFolders.sort(),
    removedFolders: removedFolders.sort(),
  };
}
