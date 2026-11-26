import { generateId } from '../forge/encoding.js';
import {
  mergeBookmarkEntries,
  mergeContributorNotes,
  normalizeUserList,
  normalizeUsername,
} from '../markdown/parse.js';
import type {
  BookmarkEntry,
  BookmarkTree,
  ConflictRecord,
  FolderNode,
  SyncDiffSummary,
  SyncMode,
} from '../types.js';
import {
  collectFoldersMap,
  computeTreeDelta,
  flattenBookmarks,
  summarizeBrowserChanges,
  summarizeRepoChanges,
  type BookmarkItemRef,
} from './diff.js';

export interface ArchivedBookmarkInput {
  folderPath: string;
  folderTitle: string;
  entry: BookmarkEntry;
}

export interface ThreeWayMergeOptions {
  currentUser?: string;
  syncMode?: SyncMode;
  today?: string;
}

export interface ThreeWayMergeResult {
  merged: BookmarkTree;
  browserTargetTree: BookmarkTree;
  newlyArchived: ArchivedBookmarkInput[];
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

function withSavedBy(entry: BookmarkEntry, user?: string): BookmarkEntry {
  const cleanList = normalizeUserList([
    ...(entry.savedBy ?? []),
    ...(user ? [user] : []),
  ]);
  return {
    ...entry,
    tags: [...entry.tags],
    ...(cleanList.length > 0 ? { savedBy: cleanList } : {}),
  };
}

function carryOverRichMetadata(
  preferred: BookmarkEntry,
  fallback?: BookmarkEntry,
  preserveSavedByFromFallback = true,
): BookmarkEntry {
  if (!fallback) {
    return {
      ...preferred,
      tags: [...preferred.tags],
      ...(preferred.savedBy ? { savedBy: [...preferred.savedBy] } : {}),
      ...(preferred.contributorNotes
        ? { contributorNotes: { ...preferred.contributorNotes } }
        : {}),
    };
  }
  const savedBy =
    preferred.savedBy !== undefined
      ? [...preferred.savedBy]
      : preserveSavedByFromFallback && fallback.savedBy !== undefined
        ? [...fallback.savedBy]
        : undefined;
  const contributorNotes = mergeContributorNotes(
    fallback.contributorNotes,
    preferred.contributorNotes,
  );
  const archiveUrl = preferred.archiveUrl ?? fallback.archiveUrl;
  const mergedTags = [...new Set([...fallback.tags, ...preferred.tags])];
  return {
    ...preferred,
    note: preferred.note !== undefined ? preferred.note : fallback.note,
    ...(contributorNotes ? { contributorNotes } : {}),
    ...(archiveUrl ? { archiveUrl } : {}),
    tags: mergedTags,
    added: preferred.added !== undefined ? preferred.added : fallback.added,
    ...(savedBy && savedBy.length > 0 ? { savedBy } : {}),
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
      // Root container folder title is owned by the browser locally and never renamed by applyTreeToBrowser
      ...(folder.path ? { title: folder.title } : {}),
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

function removeUserOrArchive(
  folderPath: string,
  folderTitle: string,
  entry: BookmarkEntry,
  currentUser: string | undefined,
  today: string,
  newlyArchived: ArchivedBookmarkInput[],
): BookmarkEntry | null {
  if (currentUser && entry.savedBy && entry.savedBy.length > 0) {
    const remaining = entry.savedBy.filter((u) => u !== currentUser);
    if (remaining.length > 0) {
      let nextNotes = entry.contributorNotes ? { ...entry.contributorNotes } : undefined;
      if (nextNotes && currentUser in nextNotes) {
        delete nextNotes[currentUser];
        if (Object.keys(nextNotes).length === 0) {
          nextNotes = undefined;
        }
      }
      const next: BookmarkEntry = {
        ...entry,
        tags: [...entry.tags],
        savedBy: remaining,
      };
      if (nextNotes) {
        next.contributorNotes = nextNotes;
      } else {
        delete next.contributorNotes;
      }
      return next;
    }
  }

  const archivedEntry: BookmarkEntry = {
    ...entry,
    tags: [...entry.tags],
    ...(entry.savedBy && entry.savedBy.length > 0
      ? { savedBy: [...entry.savedBy] }
      : currentUser
        ? { savedBy: [currentUser] }
        : {}),
    archivedAt: today,
  };
  newlyArchived.push({
    folderPath,
    folderTitle,
    entry: archivedEntry,
  });
  return null;
}

function upsertMergedIntoFolder(
  folderBookmarks: Map<string, BookmarkEntry[]>,
  folderPath: string,
  incoming: BookmarkEntry,
): { matchedExisting?: BookmarkEntry } {
  const list = folderBookmarks.get(folderPath) ?? [];
  const existingIdx = list.findIndex(
    (item) => item.normalizedUrl === incoming.normalizedUrl,
  );
  if (existingIdx !== -1) {
    const existing = list[existingIdx]!;
    list[existingIdx] = mergeBookmarkEntries(existing, incoming);
    folderBookmarks.set(folderPath, list);
    return { matchedExisting: existing };
  }
  list.push({
    ...incoming,
    tags: [...incoming.tags],
    ...(incoming.savedBy ? { savedBy: [...incoming.savedBy] } : {}),
  });
  folderBookmarks.set(folderPath, list);
  return {};
}

function buildMergedFolderTree(
  allFolderPaths: Set<string>,
  folderBookmarks: Map<string, BookmarkEntry[]>,
  baseFolders: Map<string, FolderNode>,
  localFolders: Map<string, FolderNode>,
  remoteFolders: Map<string, FolderNode>,
  conflicts: ConflictRecord[],
  isInitialUnion: boolean,
  contributeOnly: boolean,
): BookmarkTree {
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

  const keptPaths = new Set<string>(requiredByContent);
  for (const path of allFolderPaths) {
    if (!path || keptPaths.has(path)) continue;
    const inBase = baseFolders.has(path);
    const inLocal = localFolders.has(path);
    const inRemote = remoteFolders.has(path);

    if (contributeOnly) {
      if (inRemote || (!inBase && inLocal)) {
        keptPaths.add(path);
      }
    } else if (isInitialUnion) {
      if (inLocal || inRemote) keptPaths.add(path);
    } else if (!inBase) {
      if (inLocal || inRemote) keptPaths.add(path);
    } else if (inLocal && inRemote) {
      keptPaths.add(path);
    }
  }

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

    if (contributeOnly) {
      title = r?.title ?? l?.title ?? defaultTitleFromPath(path);
      order = r?.order ?? l?.order ?? 0;
    } else if (isInitialUnion) {
      title = r?.title ?? l?.title ?? defaultTitleFromPath(path);
      order = r?.order ?? l?.order ?? 0;
    } else if (!path && r) {
      // Root folder title in remote bookmarks/README.md is authoritative (local browser root name is never renamed)
      title = r.title;
      order = r.order;
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
            localTitle: l.title,
            remoteTitle: r.title,
            localFolderPath: path,
            remoteFolderPath: path,
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

    // When remote folder exists, treat its Markdown metadata as authoritative so manual deletions aren't resurrected
    const description = r ? r.description : (b?.description ?? l?.description);
    const maintainers = r ? r.maintainers : (b?.maintainers ?? l?.maintainers);
    const introMarkdown = r ? r.introMarkdown : (b?.introMarkdown ?? l?.introMarkdown);
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
      ...(maintainers && maintainers.length > 0 ? { maintainers: [...maintainers] } : {}),
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

function mergeContributeOnly(
  base: BookmarkTree | null,
  local: BookmarkTree,
  remote: BookmarkTree,
  options: {
    currentUser?: string;
    today: string;
    baseFolders: Map<string, FolderNode>;
    localFolders: Map<string, FolderNode>;
    remoteFolders: Map<string, FolderNode>;
    allFolderPaths: Set<string>;
  },
): ThreeWayMergeResult {
  const {
    currentUser,
    today,
    baseFolders,
    localFolders,
    remoteFolders,
    allFolderPaths,
  } = options;
  const conflicts: ConflictRecord[] = [];
  const newlyArchived: ArchivedBookmarkInput[] = [];
  const folderBookmarks = new Map<string, BookmarkEntry[]>();

  const folderTitleFor = (path: string): string =>
    remoteFolders.get(path)?.title ??
    localFolders.get(path)?.title ??
    baseFolders.get(path)?.title ??
    defaultTitleFromPath(path);

  // Start with all remote bookmarks untouched
  for (const rItem of flattenBookmarks(remote)) {
    const list = folderBookmarks.get(rItem.folderPath) ?? [];
    list.push({
      ...rItem.entry,
      tags: [...rItem.entry.tags],
      ...(rItem.entry.savedBy ? { savedBy: [...rItem.entry.savedBy] } : {}),
    });
    folderBookmarks.set(rItem.folderPath, list);
  }

  const unsaveFromFolder = (
    folderPath: string,
    normUrl: string,
    archiveIfLast = true,
  ): { entry: BookmarkEntry; otherSaversRemain: boolean } | undefined => {
    const list = folderBookmarks.get(folderPath);
    if (!list) return undefined;
    const idx = list.findIndex((item) => item.normalizedUrl === normUrl);
    if (idx === -1) return undefined;
    const target = list[idx]!;
    if (!archiveIfLast) {
      const remaining =
        currentUser && target.savedBy
          ? target.savedBy.filter((u) => u !== currentUser)
          : [];
      if (remaining.length > 0) {
        let nextNotes = target.contributorNotes ? { ...target.contributorNotes } : undefined;
        if (nextNotes && currentUser && currentUser in nextNotes) {
          delete nextNotes[currentUser];
          if (Object.keys(nextNotes).length === 0) nextNotes = undefined;
        }
        const updated: BookmarkEntry = {
          ...target,
          tags: [...target.tags],
          savedBy: remaining,
        };
        if (nextNotes) updated.contributorNotes = nextNotes;
        else delete updated.contributorNotes;
        list[idx] = updated;
        return { entry: target, otherSaversRemain: true };
      }
      list.splice(idx, 1);
      return { entry: target, otherSaversRemain: false };
    }

    const updated = removeUserOrArchive(
      folderPath,
      folderTitleFor(folderPath),
      target,
      currentUser,
      today,
      newlyArchived,
    );
    if (updated) {
      list[idx] = updated;
      return { entry: target, otherSaversRemain: true };
    }
    list.splice(idx, 1);
    return { entry: target, otherSaversRemain: false };
  };

  if (!base) {
    // First contribute-only sync: treat all local bookmarks as additions/merges
    for (const lItem of flattenBookmarks(local)) {
      const attributed = withSavedBy(lItem.entry, currentUser);
      const { matchedExisting } = upsertMergedIntoFolder(folderBookmarks, lItem.folderPath, {
        ...attributed,
        order:
          (folderBookmarks.get(lItem.folderPath)?.length ?? 0) +
          1000 +
          lItem.entry.order,
      });
      if (matchedExisting && matchedExisting.title !== lItem.entry.title) {
        conflicts.push(
          makeConflict({
            folderPath: lItem.folderPath,
            url: lItem.entry.url,
            kind: 'title-conflict',
            resolution: 'remote-won',
            localSummary: lItem.entry.title,
            remoteSummary: matchedExisting.title,
            localTitle: lItem.entry.title,
            remoteTitle: matchedExisting.title,
            localFolderPath: lItem.folderPath,
            remoteFolderPath: lItem.folderPath,
          }),
        );
      }
    }
  } else {
    const localDelta = computeTreeDelta(base, local, { browserSource: true });

    for (const [id, baseRef] of localDelta.baseById.entries()) {
      const lStatus = localDelta.baseStates.get(id)!;
      if (lStatus.kind === 'unchanged') {
        continue;
      }

      if (lStatus.kind === 'deleted') {
        unsaveFromFolder(baseRef.folderPath, baseRef.entry.normalizedUrl, true);
        continue;
      }

      if (lStatus.kind === 'moved') {
        // Moving is NOT a deletion — never archive the bookmark in the old folder
        const removed = unsaveFromFolder(
          baseRef.folderPath,
          baseRef.entry.normalizedUrl,
          false,
        );
        const fallbackForMove = removed?.otherSaversRemain
          ? {
              ...removed.entry,
              contributorNotes:
                currentUser && removed.entry.contributorNotes?.[currentUser]
                  ? { [currentUser]: removed.entry.contributorNotes[currentUser]! }
                  : undefined,
            }
          : (removed?.entry ?? baseRef.entry);
        const carried = carryOverRichMetadata(
          withSavedBy(lStatus.entry, currentUser),
          fallbackForMove,
          false,
        );
        upsertMergedIntoFolder(folderBookmarks, lStatus.targetPath, {
          ...carried,
          order:
            (folderBookmarks.get(lStatus.targetPath)?.length ?? 0) +
            1000 +
            lStatus.entry.order,
        });
        continue;
      }

      if (lStatus.kind === 'edited') {
        const list = folderBookmarks.get(lStatus.targetPath) ?? [];
        const existingIdx = list.findIndex(
          (item) => item.normalizedUrl === lStatus.entry.normalizedUrl,
        );
        if (existingIdx !== -1) {
          const existing = list[existingIdx]!;
          const otherSavers = (existing.savedBy ?? []).filter(
            (u) => u !== currentUser,
          );
          const merged = mergeBookmarkEntries(
            existing,
            withSavedBy(lStatus.entry, currentUser),
          );
          list[existingIdx] =
            otherSavers.length === 0
              ? { ...merged, title: lStatus.entry.title, url: lStatus.entry.url }
              : merged;
          folderBookmarks.set(lStatus.targetPath, list);
        } else {
          // Remote deleted while local edited -> keep edited (non-destructive)
          const kept = carryOverRichMetadata(
            withSavedBy(lStatus.entry, currentUser),
            baseRef.entry,
            false,
          );
          conflicts.push(
            makeConflict({
              folderPath: lStatus.targetPath,
              url: lStatus.entry.url,
              kind: 'edit-vs-delete',
              resolution: 'kept-edited',
              localSummary: `Modified "${lStatus.entry.title}"`,
              remoteSummary: `Deleted from "${baseRef.folderPath || 'root'}"`,
              localTitle: lStatus.entry.title,
              localFolderPath: lStatus.targetPath,
              remoteFolderPath: baseRef.folderPath,
              deletedSide: 'remote',
            }),
          );
          upsertMergedIntoFolder(folderBookmarks, lStatus.targetPath, kept);
        }
      }
    }

    for (const lAdd of localDelta.unpairedAdds) {
      const attributed = withSavedBy(lAdd.entry, currentUser);
      upsertMergedIntoFolder(folderBookmarks, lAdd.folderPath, {
        ...attributed,
        order:
          (folderBookmarks.get(lAdd.folderPath)?.length ?? 0) +
          1000 +
          lAdd.entry.order,
      });
    }
  }

  const merged = buildMergedFolderTree(
    allFolderPaths,
    folderBookmarks,
    baseFolders,
    localFolders,
    remoteFolders,
    conflicts,
    !base,
    true,
  );

  const archivedSummary = newlyArchived.map((a) => ({
    folderPath: a.folderPath,
    title: a.entry.title,
    url: a.entry.url,
  }));

  return {
    merged,
    browserTargetTree: local,
    newlyArchived,
    conflicts,
    localPatchNeeded: false,
    summary: {
      ...summarizeRepoChanges(remote, merged, archivedSummary),
      remoteAddedBookmarks: [],
      remoteRemovedBookmarks: [],
      remoteUpdatedBookmarks: [],
      remoteMovedBookmarks: [],
    },
  };
}

export function threeWayMerge(
  base: BookmarkTree | null,
  local: BookmarkTree,
  remote: BookmarkTree,
  options: ThreeWayMergeOptions = {},
): ThreeWayMergeResult {
  const currentUser = options.currentUser
    ? normalizeUsername(options.currentUser) || undefined
    : undefined;
  const syncMode: SyncMode = options.syncMode ?? 'two-way';
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const localFolders = collectFoldersMap(local);
  const remoteFolders = collectFoldersMap(remote);
  const baseFolders = base ? collectFoldersMap(base) : new Map<string, FolderNode>();

  const allFolderPaths = new Set<string>([
    ...baseFolders.keys(),
    ...localFolders.keys(),
    ...remoteFolders.keys(),
  ]);

  if (syncMode === 'subscribe-only') {
    return {
      merged: remote,
      browserTargetTree: remote,
      newlyArchived: [],
      conflicts: [],
      localPatchNeeded: !areBrowserVisibleEqual(local, remote),
      summary: {
        addedBookmarks: [],
        removedBookmarks: [],
        updatedBookmarks: [],
        movedBookmarks: [],
        archivedBookmarks: [],
        addedFolders: [],
        removedFolders: [],
        ...summarizeBrowserChanges(local, remote),
      },
    };
  }

  if (syncMode === 'contribute-only' || syncMode === 'propose-pr') {
    return mergeContributeOnly(base, local, remote, {
      currentUser,
      today,
      baseFolders,
      localFolders,
      remoteFolders,
      allFolderPaths,
    });
  }

  const conflicts: ConflictRecord[] = [];
  const newlyArchived: ArchivedBookmarkInput[] = [];
  const folderBookmarks = new Map<string, BookmarkEntry[]>();

  const folderTitleFor = (path: string): string =>
    remoteFolders.get(path)?.title ??
    localFolders.get(path)?.title ??
    baseFolders.get(path)?.title ??
    defaultTitleFromPath(path);

  const pushBookmark = (folderPath: string, entry: BookmarkEntry): void => {
    const list = folderBookmarks.get(folderPath) ?? [];
    list.push(entry);
    folderBookmarks.set(folderPath, list);
  };

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
      pushBookmark(rItem.folderPath, {
        ...rItem.entry,
        tags: [...rItem.entry.tags],
        ...(rItem.entry.savedBy ? { savedBy: [...rItem.entry.savedBy] } : {}),
      });
    }

    for (const lItem of localItems) {
      const attributedLocal = withSavedBy(lItem.entry, currentUser);
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
              localTitle: lItem.entry.title,
              remoteTitle: matched.entry.title,
              localFolderPath: lItem.folderPath,
              remoteFolderPath: lItem.folderPath,
            }),
          );
        }
        upsertMergedIntoFolder(folderBookmarks, lItem.folderPath, attributedLocal);
        continue;
      }
      pushBookmark(lItem.folderPath, {
        ...attributedLocal,
        order:
          (folderBookmarks.get(lItem.folderPath)?.length ?? 0) +
          1000 +
          lItem.entry.order,
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
      false,
    );

    return {
      merged,
      browserTargetTree: merged,
      newlyArchived,
      conflicts,
      localPatchNeeded: !areBrowserVisibleEqual(local, merged),
      summary: {
        ...summarizeRepoChanges(remote, merged, []),
        ...summarizeBrowserChanges(local, merged),
      },
    };
  }

  // Full 3-way merge
  const localDelta = computeTreeDelta(base, local, { browserSource: true });
  const remoteDelta = computeTreeDelta(base, remote, { browserSource: false });

  for (const [id, baseRef] of localDelta.baseById.entries()) {
    const lStatus = localDelta.baseStates.get(id)!;
    const rStatus = remoteDelta.baseStates.get(id)!;

    if (lStatus.kind === 'deleted' && rStatus.kind === 'deleted') {
      continue;
    }

    if (lStatus.kind === 'deleted' && rStatus.kind === 'unchanged') {
      const kept = removeUserOrArchive(
        baseRef.folderPath,
        folderTitleFor(baseRef.folderPath),
        rStatus.entry,
        currentUser,
        today,
        newlyArchived,
      );
      if (kept) {
        pushBookmark(rStatus.targetPath, kept);
      }
      continue;
    }

    if (rStatus.kind === 'deleted' && lStatus.kind === 'unchanged') {
      continue;
    }

    if (
      lStatus.kind === 'deleted' &&
      (rStatus.kind === 'edited' || rStatus.kind === 'moved')
    ) {
      conflicts.push(
        makeConflict({
          folderPath: rStatus.targetPath,
          url: rStatus.entry.url,
          kind: 'edit-vs-delete',
          resolution: 'kept-edited',
          localSummary: `Deleted from "${baseRef.folderPath || 'root'}"`,
          remoteSummary: `Modified "${rStatus.entry.title}" in "${rStatus.targetPath || 'root'}"`,
          remoteTitle: rStatus.entry.title,
          localFolderPath: baseRef.folderPath,
          remoteFolderPath: rStatus.targetPath,
          deletedSide: 'local',
        }),
      );
      pushBookmark(rStatus.targetPath, {
        ...rStatus.entry,
        tags: [...rStatus.entry.tags],
      });
      continue;
    }

    if (
      rStatus.kind === 'deleted' &&
      (lStatus.kind === 'edited' || lStatus.kind === 'moved')
    ) {
      conflicts.push(
        makeConflict({
          folderPath: lStatus.targetPath,
          url: lStatus.entry.url,
          kind: 'edit-vs-delete',
          resolution: 'kept-edited',
          localSummary: `Modified "${lStatus.entry.title}" in "${lStatus.targetPath || 'root'}"`,
          remoteSummary: `Deleted from "${baseRef.folderPath || 'root'}"`,
          localTitle: lStatus.entry.title,
          localFolderPath: lStatus.targetPath,
          remoteFolderPath: baseRef.folderPath,
          deletedSide: 'remote',
        }),
      );
      pushBookmark(
        lStatus.targetPath,
        withSavedBy(carryOverRichMetadata(lStatus.entry, baseRef.entry), currentUser),
      );
      continue;
    }

    if (lStatus.kind === 'unchanged' && rStatus.kind === 'unchanged') {
      pushBookmark(rStatus.targetPath, {
        ...rStatus.entry,
        tags: [...rStatus.entry.tags],
      });
      continue;
    }

    if (
      lStatus.kind !== 'unchanged' &&
      lStatus.kind !== 'deleted' &&
      rStatus.kind === 'unchanged'
    ) {
      pushBookmark(
        lStatus.targetPath,
        withSavedBy(carryOverRichMetadata(lStatus.entry, rStatus.entry), currentUser),
      );
      continue;
    }

    if (
      lStatus.kind === 'unchanged' &&
      rStatus.kind !== 'unchanged' &&
      rStatus.kind !== 'deleted'
    ) {
      pushBookmark(rStatus.targetPath, {
        ...rStatus.entry,
        tags: [...rStatus.entry.tags],
      });
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
            localTitle: lStatus.entry.title,
            remoteTitle: rStatus.entry.title,
            localFolderPath: lStatus.targetPath,
            remoteFolderPath: rStatus.targetPath,
          }),
        );
      }

      // Preserve explicit local annotations/tags even when remote wins on title/folder
      const mergedConcurrent = mergeBookmarkEntries(
        rStatus.entry,
        withSavedBy(lStatus.entry, currentUser),
      );
      pushBookmark(rStatus.targetPath, mergedConcurrent);
    }
  }

  // Merge newly added items from both sides
  const remoteAddMap = new Map<string, BookmarkItemRef[]>();
  for (const rAdd of remoteDelta.unpairedAdds) {
    const key = `${rAdd.folderPath}::${rAdd.entry.normalizedUrl}`;
    const list = remoteAddMap.get(key) ?? [];
    list.push(rAdd);
    remoteAddMap.set(key, list);
    upsertMergedIntoFolder(folderBookmarks, rAdd.folderPath, rAdd.entry);
  }

  for (const lAdd of localDelta.unpairedAdds) {
    const attributedLocal = withSavedBy(lAdd.entry, currentUser);
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
            localTitle: lAdd.entry.title,
            remoteTitle: matched.entry.title,
            localFolderPath: lAdd.folderPath,
            remoteFolderPath: lAdd.folderPath,
          }),
        );
      }
      upsertMergedIntoFolder(folderBookmarks, lAdd.folderPath, attributedLocal);
      continue;
    }

    upsertMergedIntoFolder(folderBookmarks, lAdd.folderPath, {
      ...attributedLocal,
      order:
        (folderBookmarks.get(lAdd.folderPath)?.length ?? 0) + 1000 + lAdd.entry.order,
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
    false,
  );

  const archivedSummary = newlyArchived.map((a) => ({
    folderPath: a.folderPath,
    title: a.entry.title,
    url: a.entry.url,
  }));

  return {
    merged,
    browserTargetTree: merged,
    newlyArchived,
    conflicts,
    localPatchNeeded: !areBrowserVisibleEqual(local, merged),
    summary: {
      ...summarizeRepoChanges(remote, merged, archivedSummary),
      ...summarizeBrowserChanges(local, merged),
    },
  };
}
