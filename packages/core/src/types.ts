export type ForgeKind = 'github' | 'gitlab' | 'forgejo';

export type SyncMode = 'two-way' | 'contribute-only';

export interface BookmarkEntry {
  title: string;
  url: string;
  normalizedUrl: string;
  added?: string;
  note?: string;
  tags: string[];
  savedBy?: string[];
  archivedAt?: string;
  order: number;
}

export interface FolderNode {
  path: string;
  slug: string;
  title: string;
  order: number;
  description?: string;
  introMarkdown?: string;
  bookmarks: BookmarkEntry[];
  children: FolderNode[];
}

export interface BookmarkTree {
  root: FolderNode;
}

export interface SafetyConfig {
  filterPrivateUrls: boolean;
  filterCredentials: boolean;
  stripTrackingParams: boolean;
  previewFirstSync: boolean;
  customStripParams?: string[];
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  filterPrivateUrls: true,
  filterCredentials: true,
  stripTrackingParams: true,
  previewFirstSync: true,
};

export type SkippedUrlReason =
  | 'invalid-url'
  | 'non-public-scheme'
  | 'private-host'
  | 'embedded-credentials'
  | 'sensitive-query-param';

export interface SkippedUrlRecord {
  url: string;
  title: string;
  folderPath: string;
  reason: SkippedUrlReason;
  detail: string;
}

export interface CleanedUrlRecord {
  folderPath: string;
  title: string;
  originalUrl: string;
  cleanedUrl: string;
}

export type ConflictKind =
  | 'edit-vs-delete'
  | 'title-conflict'
  | 'move-conflict'
  | 'folder-title-conflict';

export interface ConflictRecord {
  id: string;
  timestamp: string;
  folderPath: string;
  url: string;
  kind: ConflictKind;
  resolution: 'kept-edited' | 'remote-won';
  localSummary: string;
  remoteSummary: string;
}

export interface SharedGitHubAccount {
  id: string;
  instanceUrl: string;
  username?: string;
  displayName?: string;
  token: string;
  authMethod: 'device-flow' | 'pat';
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  oauthClientId?: string;
  updatedAt: string;
}

export interface ProfileConfig {
  id: string;
  name: string;
  enabled: boolean;
  forge: ForgeKind;
  instanceUrl?: string;
  owner: string;
  repo: string;
  branch: string;
  rootDir: string;
  accountId?: string;
  token: string;
  authMethod?: 'pat' | 'device-flow';
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  oauthClientId?: string;
  username?: string;
  syncMode?: SyncMode;
  rootFolderId: string;
  rootFolderTitle?: string;
  siteUrl?: string;
  autoSync: boolean;
  pushDebounceSeconds: number;
  pullIntervalMinutes: number;
  safety: SafetyConfig;
}

export interface SyncSnapshot {
  lastSyncedCommitSha: string | null;
  lastSyncedAt: string;
  lastSyncedTree: BookmarkTree;
}

export interface SyncDiffSummary {
  addedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  removedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  updatedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  movedBookmarks: Array<{ fromPath: string; toPath: string; title: string; url: string }>;
  archivedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  addedFolders: string[];
  removedFolders: string[];
  remoteAddedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  remoteRemovedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  remoteUpdatedBookmarks: Array<{ folderPath: string; title: string; url: string }>;
  remoteMovedBookmarks: Array<{ fromPath: string; toPath: string; title: string; url: string }>;
}

export interface SyncResult {
  dryRun: boolean;
  commitSha: string | null;
  committed: boolean;
  localPatchNeeded: boolean;
  remoteCommitNeeded: boolean;
  mergedTree: BookmarkTree;
  browserTargetTree: BookmarkTree;
  archivedCount: number;
  snapshot: SyncSnapshot;
  summary: SyncDiffSummary;
  conflicts: ConflictRecord[];
  skipped: SkippedUrlRecord[];
  cleanedUrls: CleanedUrlRecord[];
  upserts: string[];
  deletes: string[];
}
