import type {
  ConflictRecord,
  ForgeKind,
  GlyphrigGardenManifest,
  PendingBookmarkAnnotation,
  ProfileConfig,
  SharedGitHubAccount,
  SkippedUrlRecord,
  SyncDiffSummary,
  SyncResult,
  SyncSnapshot,
} from '@glyphrig/core';
import type { ProfileSubfolderOption, SavedPageMatch } from './page-match.js';

export interface SyncLogEntry {
  id: string;
  timestamp: string;
  profileId: string;
  profileName: string;
  trigger: 'manual' | 'debounce' | 'alarm' | 'startup';
  status: 'ok' | 'warning' | 'error';
  commitSha?: string | null;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  message: string;
  skippedCount: number;
  conflictCount: number;
  skipped?: SkippedUrlRecord[];
}

export interface SelectableFolderNode {
  id: string;
  title: string;
  depth: number;
  selectable: boolean;
  childCount: number;
}

export interface DryRunPreviewPayload {
  profileId: string;
  profileName: string;
  commitSha: string | null;
  remoteCommitNeeded: boolean;
  localPatchNeeded: boolean;
  summary: SyncDiffSummary;
  skipped: SkippedUrlRecord[];
  conflicts: ConflictRecord[];
  upserts: string[];
  deletes: string[];
}

export interface PageInspectionPayload {
  matches: SavedPageMatch[];
  tagsByProfile: Record<string, string[]>;
  subfoldersByProfile: Record<string, ProfileSubfolderOption[]>;
}

export interface SaveAndAnnotateResult {
  savedToBrowser: boolean;
  syncResult?: SyncResult;
  state: ExtensionStatePayload;
}

export interface ExtensionStatePayload {
  profiles: ProfileConfig[];
  sharedAccounts: SharedGitHubAccount[];
  activeProfileId: string | null;
  snapshots: Record<string, SyncSnapshot>;
  history: SyncLogEntry[];
  conflicts: ConflictRecord[];
  dirtyProfiles: Record<string, number>;
  pendingAnnotations: Record<string, PendingBookmarkAnnotation[]>;
  livePageBadgeEnabled: boolean;
  githubOAuthClientIdOverride: string;
  effectiveGithubOAuthClientId: string;
}

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  | { type: 'LIST_FOLDERS' }
  | { type: 'SAVE_PROFILE'; profile: ProfileConfig }
  | { type: 'DELETE_PROFILE'; profileId: string }
  | { type: 'SAVE_SHARED_ACCOUNT'; account: SharedGitHubAccount }
  | { type: 'DELETE_SHARED_ACCOUNT'; accountId: string }
  | { type: 'FETCH_GITHUB_USER'; token: string; instanceUrl?: string }
  | { type: 'RUN_DRY_RUN'; profileId: string }
  | { type: 'RUN_SYNC'; profileId: string; trigger?: 'manual' }
  | { type: 'RUN_SYNC_ALL' }
  | {
      type: 'TEST_CONNECTION';
      config: {
        profileId?: string;
        accountId?: string;
        forge: ForgeKind;
        instanceUrl?: string;
        owner: string;
        repo: string;
        branch: string;
        token: string;
      };
    }
  | { type: 'START_GITHUB_DEVICE_FLOW'; instanceUrl?: string; clientId?: string }
  | {
      type: 'POLL_GITHUB_DEVICE_FLOW';
      deviceCode: string;
      instanceUrl?: string;
      clientId?: string;
    }
  | { type: 'SAVE_OAUTH_CLIENT_ID'; clientId: string }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'INSPECT_PAGE_URL'; url: string }
  | {
      type: 'SAVE_AND_ANNOTATE_PAGE';
      profileId: string;
      folderPath: string;
      url: string;
      title: string;
      note?: string;
      contributorNote?: string;
      tags: string[];
      syncNow?: boolean;
    }
  | {
      type: 'RESOLVE_CONFLICT';
      conflictId: string;
      choice: 'local' | 'remote' | 'merged' | 'dismissed';
    }
  | { type: 'SET_LIVE_PAGE_BADGE'; enabled: boolean }
  | { type: 'FETCH_GARDEN_MANIFEST'; url: string };

export type _ManifestTypeRef = GlyphrigGardenManifest;
