import type {
  ConflictRecord,
  ForgeKind,
  ProfileConfig,
  SkippedUrlRecord,
  SyncDiffSummary,
  SyncSnapshot,
} from '@glyphrig/core';

export interface SyncLogEntry {
  id: string;
  timestamp: string;
  profileId: string;
  profileName: string;
  trigger: 'manual' | 'debounce' | 'alarm' | 'startup';
  status: 'ok' | 'warning' | 'error';
  commitSha?: string | null;
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

export interface ExtensionStatePayload {
  profiles: ProfileConfig[];
  activeProfileId: string | null;
  snapshots: Record<string, SyncSnapshot>;
  history: SyncLogEntry[];
  conflicts: ConflictRecord[];
  dirtyProfiles: Record<string, number>;
  githubOAuthClientIdOverride: string;
  effectiveGithubOAuthClientId: string;
}

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  | { type: 'LIST_FOLDERS' }
  | { type: 'SAVE_PROFILE'; profile: ProfileConfig }
  | { type: 'DELETE_PROFILE'; profileId: string }
  | { type: 'RUN_DRY_RUN'; profileId: string }
  | { type: 'RUN_SYNC'; profileId: string; trigger?: 'manual' }
  | { type: 'RUN_SYNC_ALL' }
  | {
      type: 'TEST_CONNECTION';
      config: {
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
  | { type: 'CLEAR_HISTORY' };
