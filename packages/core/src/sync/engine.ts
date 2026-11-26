import { ForgeError, type ForgeAdapter } from '../forge/types.js';
import {
  mergeContributorNotes,
  normalizeUserList,
  normalizeUsername,
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
import { applyAutoTagRules } from '../rules/autotag.js';
import { isSafeHttpUrl, sanitizeBookmarkTree } from '../safety/filter.js';
import { normalizeUrl } from '../safety/sanitize.js';
import {
  DEFAULT_SAFETY_CONFIG,
  type AutoTagRule,
  type BookmarkEntry,
  type BookmarkTree,
  type FolderNode,
  type PendingBookmarkAnnotation,
  type SafetyConfig,
  type SkippedUrlRecord,
  type SyncDiffSummary,
  type SyncMode,
  type SyncResult,
  type SyncSnapshot,
} from '../types.js';
import { collectFoldersMap, summarizeRepoChanges } from './diff.js';
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
  proposalBranch?: string;
  localAnnotations?: PendingBookmarkAnnotation[];
  autoTagRules?: AutoTagRule[];
  maxRetries?: number;
}

function buildDefaultCommitMessage(upserts: Map<string, string>, deletes: string[]): string {
  const count = upserts.size + deletes.length;
  return `chore(bookmarks): sync ${count} folder ${count === 1 ? 'file' : 'files'} via Glyphrig`;
}

function buildProposalPrBody(
  summary: SyncDiffSummary,
  upserts: Map<string, string>,
  deletes: string[],
  currentUser?: string,
): string {
  const lines: string[] = [
    currentUser
      ? `Proposed bookmark updates from **@${currentUser}** via [Glyphrig](https://github.com/Glyphrig/Glyphrig).`
      : 'Proposed bookmark updates via [Glyphrig](https://github.com/Glyphrig/Glyphrig).',
    '',
  ];

  if (summary.addedBookmarks.length > 0) {
    lines.push(`### Added (${summary.addedBookmarks.length})`);
    for (const item of summary.addedBookmarks.slice(0, 30)) {
      lines.push(`- [${item.title}](${item.url}) in \`${item.folderPath || 'root'}\``);
    }
    if (summary.addedBookmarks.length > 30) {
      lines.push(`- …and ${summary.addedBookmarks.length - 30} more`);
    }
    lines.push('');
  }

  if (summary.updatedBookmarks.length > 0) {
    lines.push(`### Updated (${summary.updatedBookmarks.length})`);
    for (const item of summary.updatedBookmarks.slice(0, 20)) {
      lines.push(`- [${item.title}](${item.url}) in \`${item.folderPath || 'root'}\``);
    }
    lines.push('');
  }

  if (summary.archivedBookmarks.length > 0) {
    lines.push(`### Archived (${summary.archivedBookmarks.length})`);
    for (const item of summary.archivedBookmarks.slice(0, 20)) {
      lines.push(`- [${item.title}](${item.url}) from \`${item.folderPath || 'root'}\``);
    }
    lines.push('');
  }

  const changedFiles = [...upserts.keys(), ...deletes];
  if (changedFiles.length > 0) {
    lines.push(
      `_Files touched (${changedFiles.length}): ${changedFiles.map((f) => `\`${f}\``).join(', ')}_`,
    );
  }

  return lines.join('\n').trim();
}

function filterUnsafeRemoteSchemes(tree: BookmarkTree): BookmarkTree {
  function walk(folder: FolderNode): FolderNode {
    const bookmarks = folder.bookmarks
      .filter((bm) => isSafeHttpUrl(bm.url))
      .map((bm, idx) => {
        const safeArchive = bm.archiveUrl && isSafeHttpUrl(bm.archiveUrl) ? bm.archiveUrl : undefined;
        const copy: BookmarkEntry = { ...bm, order: idx };
        if (safeArchive) copy.archiveUrl = safeArchive;
        else delete copy.archiveUrl;
        return copy;
      });
    return {
      ...folder,
      bookmarks,
      children: folder.children.map(walk),
    };
  }
  return { root: walk(tree.root) };
}

function reinjectSkippedLocalBookmarks(
  browserTargetTree: BookmarkTree,
  skipped: SkippedUrlRecord[],
): BookmarkTree {
  if (skipped.length === 0) return browserTargetTree;

  const skippedByFolder = new Map<string, SkippedUrlRecord[]>();
  for (const rec of skipped) {
    const list = skippedByFolder.get(rec.folderPath) ?? [];
    list.push(rec);
    skippedByFolder.set(rec.folderPath, list);
  }

  function walk(folder: FolderNode): FolderNode {
    const extras = skippedByFolder.get(folder.path);
    const bookmarks = [...folder.bookmarks];
    if (extras && extras.length > 0) {
      const existingNorms = new Set(bookmarks.map((b) => b.normalizedUrl));
      for (const rec of extras) {
        const norm = normalizeUrl(rec.url, false);
        if (!existingNorms.has(norm)) {
          existingNorms.add(norm);
          bookmarks.push({
            title: rec.title,
            url: rec.url,
            normalizedUrl: norm,
            tags: [],
            order: bookmarks.length,
          });
        }
      }
    }
    return {
      ...folder,
      bookmarks,
      children: folder.children.map(walk),
    };
  }

  return { root: walk(browserTargetTree.root) };
}

function applyAnnotationToEntry(
  entry: BookmarkEntry,
  annotation: PendingBookmarkAnnotation,
  currentUser?: string,
): BookmarkEntry {
  const cleanUser = currentUser ? normalizeUsername(currentUser) : '';
  const mergedTags = [...entry.tags];
  const seen = new Set(mergedTags.map((t) => t.toLowerCase()));
  for (const rawTag of annotation.tags ?? []) {
    const clean = rawTag.trim().replace(/^#+/, '').toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      mergedTags.push(clean);
    }
  }

  let nextNote = entry.note;
  if (annotation.note !== undefined && annotation.note.trim()) {
    nextNote = annotation.note.trim().replace(/\s+/g, ' ');
  }

  let nextContributorNotes = entry.contributorNotes;
  if (annotation.contributorNote !== undefined && annotation.contributorNote.trim()) {
    if (cleanUser) {
      nextContributorNotes = mergeContributorNotes(entry.contributorNotes, {
        [cleanUser]: annotation.contributorNote.trim(),
      });
    } else if (!nextNote) {
      nextNote = annotation.contributorNote.trim().replace(/\s+/g, ' ');
    }
  }

  const savedBy = normalizeUserList([
    ...(entry.savedBy ?? []),
    ...(cleanUser ? [cleanUser] : []),
  ]);

  const archiveUrl =
    annotation.archiveUrl && isSafeHttpUrl(annotation.archiveUrl)
      ? annotation.archiveUrl.trim()
      : entry.archiveUrl;

  return {
    ...entry,
    ...(annotation.title && annotation.title.trim() ? { title: annotation.title.trim() } : {}),
    ...(nextNote !== undefined ? { note: nextNote } : {}),
    ...(nextContributorNotes ? { contributorNotes: nextContributorNotes } : {}),
    ...(archiveUrl ? { archiveUrl } : {}),
    tags: mergedTags,
    ...(savedBy.length > 0 ? { savedBy } : {}),
  };
}

function normalizeAnnotationKey(ann: PendingBookmarkAnnotation, safetyCfg: SafetyConfig): string {
  return normalizeUrl(
    ann.url || ann.normalizedUrl,
    safetyCfg.stripTrackingParams,
    safetyCfg.customStripParams,
  );
}

function sameTagArrays(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function applyLocalAnnotationsAndRules(
  tree: BookmarkTree,
  annotations: PendingBookmarkAnnotation[] | undefined,
  rules: AutoTagRule[] | undefined,
  safetyCfg: SafetyConfig,
  currentUser?: string,
): { tree: BookmarkTree; appliedKeys: Set<string> } {
  const byUrl = new Map<string, PendingBookmarkAnnotation[]>();
  for (const ann of annotations ?? []) {
    const norm = normalizeAnnotationKey(ann, safetyCfg);
    const list = byUrl.get(norm) ?? [];
    list.push(ann);
    byUrl.set(norm, list);
  }
  const appliedKeys = new Set<string>();

  function walk(folder: FolderNode): FolderNode {
    const bookmarks = folder.bookmarks.map((bm) => {
      let next = bm;
      const candidates = byUrl.get(bm.normalizedUrl);
      if (candidates && candidates.length > 0) {
        const match = candidates.find(
          (c) => c.folderPath === undefined || c.folderPath === folder.path,
        );
        if (match) {
          next = applyAnnotationToEntry(next, match, currentUser);
          appliedKeys.add(`${normalizeAnnotationKey(match, safetyCfg)}::${match.folderPath ?? '*'}`);
        }
      }
      if (rules && rules.length > 0) {
        const tagged = applyAutoTagRules(next, rules);
        if (!sameTagArrays(tagged, next.tags)) {
          next = { ...next, tags: tagged };
        }
      }
      return next;
    });

    return {
      ...folder,
      bookmarks,
      children: folder.children.map(walk),
    };
  }

  return { tree: { root: walk(tree.root) }, appliedKeys };
}

function applyRemainingAnnotationsToMerged(
  tree: BookmarkTree,
  annotations: PendingBookmarkAnnotation[] | undefined,
  appliedKeys: Set<string>,
  safetyCfg: SafetyConfig,
  currentUser?: string,
): { tree: BookmarkTree; changed: boolean } {
  const remaining = (annotations ?? []).filter(
    (ann) => !appliedKeys.has(`${normalizeAnnotationKey(ann, safetyCfg)}::${ann.folderPath ?? '*'}`),
  );
  if (remaining.length === 0) {
    return { tree, changed: false };
  }
  const byUrl = new Map<string, PendingBookmarkAnnotation[]>();
  for (const ann of remaining) {
    const norm = normalizeAnnotationKey(ann, safetyCfg);
    const list = byUrl.get(norm) ?? [];
    list.push(ann);
    byUrl.set(norm, list);
  }

  let changed = false;
  function walk(folder: FolderNode): FolderNode {
    const bookmarks = folder.bookmarks.map((bm) => {
      const candidates = byUrl.get(bm.normalizedUrl);
      if (!candidates || candidates.length === 0) return bm;
      const match = candidates.find(
        (c) => c.folderPath === undefined || c.folderPath === folder.path,
      );
      if (!match) return bm;
      changed = true;
      return applyAnnotationToEntry(bm, match, currentUser);
    });
    return {
      ...folder,
      bookmarks,
      children: folder.children.map(walk),
    };
  }

  return { tree: { root: walk(tree.root) }, changed };
}

export class SyncEngine {
  async sync(params: RunSyncParams): Promise<SyncResult> {
    const cleanRoot = normalizeRepoRootDir(params.rootDir);
    const safetyCfg: SafetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...params.safety };
    const syncMode: SyncMode = params.syncMode ?? 'two-way';
    const dryRun = params.dryRun ?? false;
    const maxRetries = Math.max(1, params.maxRetries ?? 3);

    const sanitizedLocal = sanitizeBookmarkTree(params.localTree, safetyCfg);
    const annotated = applyLocalAnnotationsAndRules(
      sanitizedLocal.tree,
      params.localAnnotations,
      params.autoTagRules,
      safetyCfg,
      params.currentUser,
    );

    let attempt = 0;
    while (true) {
      attempt++;
      const remoteData = await params.adapter.readBookmarkFiles(params.branch, cleanRoot);
      const parsedRemote = parseBookmarkRepoFiles(remoteData.files, cleanRoot);
      const existingArchiveDocs = parseArchiveRepoFiles(remoteData.files, cleanRoot);

      // Block dangerous remote schemes (javascript:, data:, file:, etc.) from reaching browsers
      const safeRemoteTree = filterUnsafeRemoteSchemes(parsedRemote.tree);

      // Preserve local root title if remote repo had no root README.md yet
      if (
        syncMode !== 'subscribe-only' &&
        !parsedRemote.rawDocs.has('') &&
        annotated.tree.root.title
      ) {
        safeRemoteTree.root.title = annotated.tree.root.title;
      }

      if (syncMode === 'subscribe-only') {
        const subMerge = threeWayMerge(null, params.localTree, safeRemoteTree, {
          syncMode: 'subscribe-only',
        });
        const now = new Date().toISOString();
        const sha = remoteData.commitSha;
        return {
          dryRun,
          commitSha: sha,
          committed: false,
          localPatchNeeded: subMerge.localPatchNeeded,
          remoteCommitNeeded: false,
          mergedTree: safeRemoteTree,
          browserTargetTree: subMerge.browserTargetTree,
          archivedCount: 0,
          snapshot: {
            lastSyncedCommitSha: sha,
            lastSyncedAt: now,
            lastSyncedTree: safeRemoteTree,
            lastRemoteTree: safeRemoteTree,
          },
          summary: subMerge.summary,
          conflicts: [],
          skipped: [],
          cleanedUrls: [],
          upserts: [],
          deletes: [],
        };
      }

      // In propose-pr mode, keep base anchored to what's actually merged in baseBranch
      // (avoid advancing base past unmerged proposals so Sync 2 never drops Sync 1's links)
      const effectiveBase =
        syncMode === 'propose-pr' ? null : (params.snapshot?.lastSyncedTree ?? null);

      const mergeResult = threeWayMerge(effectiveBase, annotated.tree, safeRemoteTree, {
        currentUser: params.currentUser,
        syncMode,
      });

      const postAnn = applyRemainingAnnotationsToMerged(
        mergeResult.merged,
        params.localAnnotations,
        annotated.appliedKeys,
        safetyCfg,
        params.currentUser,
      );
      const finalMergedTree = postAnn.tree;

      const finalSummary: SyncDiffSummary = postAnn.changed
        ? {
            ...mergeResult.summary,
            ...summarizeRepoChanges(
              safeRemoteTree,
              finalMergedTree,
              mergeResult.summary.archivedBookmarks,
            ),
          }
        : mergeResult.summary;

      // Never delete private/localhost/credentialed bookmarks from the user's local browser
      const safeBrowserTargetTree = reinjectSkippedLocalBookmarks(
        syncMode === 'two-way' && postAnn.changed
          ? finalMergedTree
          : mergeResult.browserTargetTree,
        sanitizedLocal.skipped,
      );

      const nextFiles = serializeBookmarkTree(
        finalMergedTree,
        cleanRoot,
        parsedRemote.rawDocs,
        { preserveExistingMetadata: false },
      );

      // Reconcile `.archived/README.md` per folder
      const mergedFolders = collectFoldersMap(finalMergedTree);
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
        syncMode === 'contribute-only'
          ? sanitizedLocal.tree
          : syncMode === 'propose-pr'
            ? (params.snapshot?.lastSyncedTree ?? safeRemoteTree)
            : finalMergedTree;

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
          mergedTree: finalMergedTree,
          browserTargetTree: safeBrowserTargetTree,
          archivedCount: mergeResult.newlyArchived.length,
          snapshot: {
            lastSyncedCommitSha: sha,
            lastSyncedAt: now,
            lastSyncedTree: snapshotTree,
            lastRemoteTree: finalMergedTree,
          },
          summary: finalSummary,
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
        if (syncMode === 'propose-pr') {
          if (!params.adapter.proposeChanges) {
            throw new ForgeError(
              `Forge adapter "${params.adapter.kind}" does not support pull request proposals.`,
              501,
              'unknown',
            );
          }
          const cleanUser = params.currentUser ? normalizeUsername(params.currentUser) : '';
          const proposalBranch =
            params.proposalBranch?.trim() ||
            `glyphrig/${cleanUser || 'contributions'}`;
          const prTitle = cleanUser
            ? `chore(bookmarks): updates from @${cleanUser}`
            : 'chore(bookmarks): proposed bookmark updates via Glyphrig';
          const prBody = buildProposalPrBody(
            finalSummary,
            upserts,
            deletes,
            cleanUser || undefined,
          );

          const proposed = await params.adapter.proposeChanges({
            baseBranch: params.branch,
            proposalBranch,
            parentSha: remoteData.commitSha,
            message,
            prTitle,
            prBody,
            upserts,
            deletes,
            existingPaths,
            existingFileShas: remoteData.fileShas,
          });

          const now = new Date().toISOString();
          return {
            dryRun: false,
            commitSha: proposed.commitSha,
            committed: true,
            localPatchNeeded:
              mergeResult.localPatchNeeded || sanitizedLocal.cleanedUrls.length > 0,
            remoteCommitNeeded: true,
            mergedTree: finalMergedTree,
            browserTargetTree: safeBrowserTargetTree,
            archivedCount: mergeResult.newlyArchived.length,
            snapshot: {
              lastSyncedCommitSha: remoteData.commitSha,
              lastSyncedAt: now,
              lastSyncedTree: snapshotTree,
              lastRemoteTree: finalMergedTree,
            },
            summary: finalSummary,
            conflicts: mergeResult.conflicts,
            skipped: sanitizedLocal.skipped,
            cleanedUrls: sanitizedLocal.cleanedUrls,
            upserts: [...upserts.keys()],
            deletes,
            pullRequestUrl: proposed.prUrl,
            ...(proposed.prNumber !== undefined
              ? { pullRequestNumber: proposed.prNumber }
              : {}),
            proposalBranch: proposed.proposalBranch,
          };
        }

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
          mergedTree: finalMergedTree,
          browserTargetTree: safeBrowserTargetTree,
          archivedCount: mergeResult.newlyArchived.length,
          snapshot: {
            lastSyncedCommitSha: committed.commitSha,
            lastSyncedAt: now,
            lastSyncedTree: snapshotTree,
            lastRemoteTree: finalMergedTree,
          },
          summary: finalSummary,
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
