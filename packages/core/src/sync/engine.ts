import { ForgeError, type ForgeAdapter } from '../forge/types.js';
import { parseBookmarkRepoFiles } from '../markdown/parse.js';
import { diffRepoFiles, serializeBookmarkTree } from '../markdown/serialize.js';
import { normalizeRepoRootDir } from '../markdown/slug.js';
import { sanitizeBookmarkTree } from '../safety/filter.js';
import {
  DEFAULT_SAFETY_CONFIG,
  type BookmarkTree,
  type SafetyConfig,
  type SyncResult,
  type SyncSnapshot,
} from '../types.js';
import { threeWayMerge } from './merge.js';

export interface RunSyncParams {
  adapter: ForgeAdapter;
  branch: string;
  rootDir: string;
  localTree: BookmarkTree;
  snapshot: SyncSnapshot | null;
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
    const dryRun = params.dryRun ?? false;
    const maxRetries = Math.max(1, params.maxRetries ?? 3);

    const sanitizedLocal = sanitizeBookmarkTree(params.localTree, safetyCfg);

    let attempt = 0;
    while (true) {
      attempt++;
      const remoteData = await params.adapter.readBookmarkFiles(params.branch, cleanRoot);
      const parsedRemote = parseBookmarkRepoFiles(remoteData.files, cleanRoot);

      // Preserve local root title if remote repo had no root README.md yet
      if (!parsedRemote.rawDocs.has('') && sanitizedLocal.tree.root.title) {
        parsedRemote.tree.root.title = sanitizedLocal.tree.root.title;
      }

      const mergeResult = threeWayMerge(
        params.snapshot?.lastSyncedTree ?? null,
        sanitizedLocal.tree,
        parsedRemote.tree,
      );

      // Preserve user's root folder title on local browser if remote had generic default
      const nextFiles = serializeBookmarkTree(
        mergeResult.merged,
        cleanRoot,
        parsedRemote.rawDocs,
      );
      const { upserts, deletes } = diffRepoFiles(nextFiles, remoteData.files);
      const remoteCommitNeeded = upserts.size > 0 || deletes.length > 0;

      if (dryRun || !remoteCommitNeeded) {
        const now = new Date().toISOString();
        const sha = remoteData.commitSha;
        return {
          dryRun,
          commitSha: sha,
          committed: false,
          localPatchNeeded: mergeResult.localPatchNeeded || sanitizedLocal.cleanedUrls.length > 0,
          remoteCommitNeeded,
          mergedTree: mergeResult.merged,
          snapshot: {
            lastSyncedCommitSha: sha,
            lastSyncedAt: now,
            lastSyncedTree: mergeResult.merged,
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
          snapshot: {
            lastSyncedCommitSha: committed.commitSha,
            lastSyncedAt: now,
            lastSyncedTree: mergeResult.merged,
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
