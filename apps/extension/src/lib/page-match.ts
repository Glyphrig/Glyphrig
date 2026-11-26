import {
  normalizeUrl,
  type FolderNode,
  type ProfileConfig,
  type SyncSnapshot,
} from '@glyphrig/core';

export interface SavedPageMatch {
  profileId: string;
  profileName: string;
  repoFullName: string;
  syncMode: string;
  folderPath: string;
  folderTitle: string;
  title: string;
  url: string;
  note?: string;
  contributorNotes?: Record<string, string>;
  tags: string[];
  savedBy: string[];
  archiveUrl?: string;
}

export interface ProfileSubfolderOption {
  path: string;
  title: string;
}

function canonicalizeForPageMatch(rawUrl: string): string | null {
  try {
    const cleaned = normalizeUrl(rawUrl, true);
    const parsed = new URL(cleaned);
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getReferenceRoot(snapshot?: SyncSnapshot): FolderNode | undefined {
  return snapshot?.lastRemoteTree?.root ?? snapshot?.lastSyncedTree?.root;
}

export function findUrlMatchesAcrossProfiles(
  rawUrl: string,
  profiles: ProfileConfig[],
  snapshots: Record<string, SyncSnapshot>,
): SavedPageMatch[] {
  const targetExact = normalizeUrl(rawUrl, true);
  const targetCanonical = canonicalizeForPageMatch(rawUrl);
  if (!targetCanonical) {
    return [];
  }

  const matches: SavedPageMatch[] = [];

  for (const profile of profiles) {
    const refRoot = getReferenceRoot(snapshots[profile.id]);
    if (!refRoot) continue;

    function walk(folder: FolderNode): void {
      for (const bm of folder.bookmarks) {
        const bmCanonical = canonicalizeForPageMatch(bm.url);
        if (
          bm.normalizedUrl === targetExact ||
          (bmCanonical !== null && bmCanonical === targetCanonical)
        ) {
          matches.push({
            profileId: profile.id,
            profileName: profile.name,
            repoFullName: `${profile.owner}/${profile.repo}`,
            syncMode: profile.syncMode ?? 'two-way',
            folderPath: folder.path,
            folderTitle: folder.title || 'Root',
            title: bm.title,
            url: bm.url,
            ...(bm.note ? { note: bm.note } : {}),
            ...(bm.contributorNotes ? { contributorNotes: bm.contributorNotes } : {}),
            tags: [...bm.tags],
            savedBy: [...(bm.savedBy ?? [])],
            ...(bm.archiveUrl ? { archiveUrl: bm.archiveUrl } : {}),
          });
        }
      }
      for (const child of folder.children) {
        walk(child);
      }
    }

    walk(refRoot);
  }

  return matches;
}

export function countUniqueCollaboratorsForUrl(matches: SavedPageMatch[]): number {
  const users = new Set<string>();
  for (const m of matches) {
    for (const u of m.savedBy) {
      users.add(u.toLowerCase());
    }
  }
  return users.size > 0 ? users.size : matches.length;
}

export function collectTagsFromSnapshot(snapshot?: SyncSnapshot): string[] {
  const refRoot = getReferenceRoot(snapshot);
  if (!refRoot) return [];
  const counts = new Map<string, number>();

  function walk(folder: FolderNode): void {
    for (const bm of folder.bookmarks) {
      for (const t of bm.tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    for (const child of folder.children) {
      walk(child);
    }
  }
  walk(refRoot);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

export function collectSubfoldersFromSnapshot(
  snapshot?: SyncSnapshot,
  rootTitleFallback = 'Root Folder',
): ProfileSubfolderOption[] {
  const refRoot = getReferenceRoot(snapshot);
  if (!refRoot) {
    return [{ path: '', title: rootTitleFallback }];
  }

  const out: ProfileSubfolderOption[] = [];
  function walk(folder: FolderNode, depth: number): void {
    const prefix = depth > 0 ? `${'  '.repeat(depth - 1)}↳ ` : '';
    out.push({
      path: folder.path,
      title: `${prefix}${folder.title || rootTitleFallback}`,
    });
    for (const child of folder.children) {
      walk(child, depth + 1);
    }
  }
  walk(refRoot, 0);
  return out;
}
