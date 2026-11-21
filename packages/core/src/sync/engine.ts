import { ForgeError, type ForgeAdapter } from '../forge/types.js';
import {
  parseArchiveRepoFiles,
  parseBookmarkRepoFiles,
} from '../markdown/parse.js';
import {
  diffRepoFiles,
  serializeArchiveDocument,
  serializeBookmarkTree,
} from '../markdown/serialize.js';
import {
  folderPathToArchiveFilePath,
  normalizeRepoRootDir,
} from '../markdown/slug.js';
import { sanitizeBookmarkTree } from '../safety/filter.js';
import {
  DEFAULT_SAFETY_CONFIG,
  type BookmarkEntry,
  type BookmarkTree,
  type SafetyConfig,
  type SyncMode,
  type SyncResult,
  type SyncSnapshot,
} from '../types.js';
import { collectFoldersMap } from './diff.js';
import { threeWayMerge } from './merge.js';

export interface RunSyncParams {
  adapter: ForgeAdapter;
  branch: string;
  rootDir: string;
  localTree: BookmarkTree;
  snapshot: SyncSnapshot | null;
  syncMode?: SyncMode;
  currentUser?: string;
  safety?: Partial<SafetyConfig>;
  dryRun?: boolean;
  commitMessage?: string;
  maxRetries?: number;
}

function buildDefaultCommitMessage(upserts: Map<string, string>, deletes: string[]): string {
  const count = upserts.size + deletes.length;
  return `chore(bookmarks): sync ${count} folder ${count === 1 ? 'file' : 'files'} via Glyphrig`;
}

export class SyncEngine {
  async sync(params: RunSyncParams): Promise<SyncResult> {
    const cleanRoot = normalizeRepoRootDir(params.rootDir);
    const safetyCfg: SafetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...params.safety };
    const syncMode: SyncMode = params.syncMode ?? 'two-way';
    const dryRun = params.dryRun ?? false;
    const maxRetries = Math.max(1, params.maxRetries ?? 3);

    const sanitizedLocal = sanitizeBookmarkTree(params.localTree, safetyCfg);

    let attempt = 0;
    while (true) {
      attempt++;
      const remoteData = await params.adapter.readBookmarkFiles(params.branch, cleanRoot);
      const parsedRemote = parseBookmarkRepoFiles(remoteData.files, cleanRoot);
      const existingArchiveDocs = parseArchiveRepoFiles(remoteData.files, cleanRoot);

      // Preserve local root title if remote repo had no root README.md yet
      if (!parsedRemote.rawDocs.has('') && sanitizedLocal.tree.root.title) {
        parsedRemote.tree.root.title = sanitizedLocal.tree.root.title;
      }

      const mergeResult = threeWayMerge(
        params.snapshot?.lastSyncedTree ?? null,
        sanitizedLocal.tree,
        parsedRemote.tree,
        {
          currentUser: params.currentUser,
          syncMode,
        },
      );

      const nextFiles = serializeBookmarkTree(
        mergeResult.merged,
        cleanRoot,
        parsedRemote.rawDocs,
      );

      // Reconcile `.archived/README.md` per folder:
      // - Append newly archived entries
      // - Remove entries whose URL is now active again in that folder
      // - Preserve untouched existing archive files verbatim
      const mergedFolders = collectFoldersMap(mergeResult.merged);
      const activeUrlsByFolder = new Map<string, Set<string>>();
      for (const [folderPath, folder] of mergedFolders.entries()) {
        activeUrlsByFolder.set(
          folderPath,
          new Set(folder.bookmarks.map((b) => b.normalizedUrl)),
        );
      }

      const newlyArchivedByFolder = new Map<
        string,
        { folderTitle: string; entries: BookmarkEntry[] }
      >();
      for (const arch of mergeResult.newlyArchived) {
        const bucket = newlyArchivedByFolder.get(arch.folderPath) ?? {
          folderTitle: arch.folderTitle,
          entries: [],
        };
        bucket.entries.push(arch.entry);
        newlyArchivedByFolder.set(arch.folderPath, bucket);
      }

      const allArchiveFolders = new Set<string>([
        ...existingArchiveDocs.keys(),
        ...newlyArchivedByFolder.keys(),
      ]);

      for (const folderPath of allArchiveFolders) {
        const archivePath = folderPathToArchiveFilePath(cleanRoot, folderPath);
        const existingDoc = existingArchiveDocs.get(folderPath);
        const addedBucket = newlyArchivedByFolder.get(folderPath);
        const activeUrls = activeUrlsByFolder.get(folderPath) ?? new Set<string>();

        const existingEntries = existingDoc?.bookmarks ?? [];
        const hasReactivated = existingEntries.some((b) =>
          activeUrls.has(b.normalizedUrl),
        );

        if (!addedBucket && !hasReactivated) {
          const rawExisting = remoteData.files.get(archivePath);
          if (rawExisting !== undefined) {
            nextFiles.set(archivePath, rawExisting);
          }
          continue;
        }

        const combined = [
          ...existingEntries.filter((b) => !activeUrls.has(b.normalizedUrl)),
          ...(addedBucket?.entries ?? []).filter((b) => !activeUrls.has(b.normalizedUrl)),
        ];

        if (combined.length > 0) {
          const rawExistingTitle = existingDoc?.title?.replace(/\s*\(Archived\)\s*$/i, '');
          const folderTitle =
            mergedFolders.get(folderPath)?.title ??
            addedBucket?.folderTitle ??
            rawExistingTitle ??
            (folderPath ? folderPath.split('/').pop() ?? 'Folder' : 'Bookmarks');
          nextFiles.set(
            archivePath,
            serializeArchiveDocument(folderPath, folderTitle, combined, existingDoc),
          );
        }
      }

      const { upserts, deletes } = diffRepoFiles(nextFiles, remoteData.files);
      const remoteCommitNeeded = upserts.size > 0 || deletes.length > 0;
      const snapshotTree =
        syncMode === 'contribute-only' ? sanitizedLocal.tree : mergeResult.merged;

      if (dryRun || !remoteCommitNeeded) {
        const now = new Date().toISOString();
        const sha = remoteData.commitSha;
        return {
          dryRun,
          commitSha: sha,
          committed: false,
          localPatchNeeded:
            mergeResult.localPatchNeeded || sanitizedLocal.cleanedUrls.length > 0,
          remoteCommitNeeded,
          mergedTree: mergeResult.merged,
          browserTargetTree: mergeResult.browserTargetTree,
          archivedCount: mergeResult.newlyArchived.length,
          snapshot: {
            lastSyncedCommitSha: sha,
            lastSyncedAt: now,
            lastSyncedTree: snapshotTree,
          },
          summary: mergeResult.summary,
          conflicts: mergeResult.conflicts,
          skipped: sanitizedLocal.skipped,
          cleanedUrls: sanitizedLocal.cleanedUrls,
          upserts: [...upserts.keys()],
          deletes,
        };
      }

      const existingPaths = new Set(remoteData.files.keys());
      const message =
        params.commitMessage ?? buildDefaultCommitMessage(upserts, deletes);

      try {
        const committed = await params.adapter.commitChanges({
          branch: params.branch,
          parentSha: remoteData.commitSha,
          message,
          upserts,
          deletes,
          existingPaths,
          existingFileShas: remoteData.fileShas,
        });

        const now = new Date().toISOString();
        return {
          dryRun: false,
          commitSha: committed.commitSha,
          committed: true,
          localPatchNeeded:
            mergeResult.localPatchNeeded || sanitizedLocal.cleanedUrls.length > 0,
          remoteCommitNeeded: true,
          mergedTree: mergeResult.merged,
          browserTargetTree: mergeResult.browserTargetTree,
          archivedCount: mergeResult.newlyArchived.length,
          snapshot: {
            lastSyncedCommitSha: committed.commitSha,
            lastSyncedAt: now,
            lastSyncedTree: snapshotTree,
          },
          summary: mergeResult.summary,
          conflicts: mergeResult.conflicts,
          skipped: sanitizedLocal.skipped,
          cleanedUrls: sanitizedLocal.cleanedUrls,
          upserts: [...upserts.keys()],
          deletes,
        };
      } catch (err) {
        if (err instanceof ForgeError && err.code === 'conflict' && attempt < maxRetries) {
          continue;
        }
        throw err;
      }
    }
  }
}
