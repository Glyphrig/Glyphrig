import type { ForgeKind } from '../types.js';

export class ForgeError extends Error {
  readonly status: number;
  readonly code: 'auth' | 'not_found' | 'conflict' | 'rate_limit' | 'network' | 'unknown';

  constructor(
    message: string,
    status: number,
    code: ForgeError['code'] = 'unknown',
  ) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
    this.code = code;
  }
}

export interface RepoConnectionInfo {
  forge: ForgeKind;
  fullName: string;
  defaultBranch: string;
  branchExists: boolean;
  headSha: string | null;
  private: boolean;
  htmlUrl?: string;
}

export interface ReadBookmarkFilesResult {
  commitSha: string | null;
  files: Map<string, string>;
  fileShas: Map<string, string>;
}

export interface CommitChangesInput {
  branch: string;
  parentSha: string | null;
  message: string;
  upserts: Map<string, string>;
  deletes: string[];
  existingPaths?: Set<string>;
  existingFileShas?: Map<string, string>;
}

export interface AuthenticatedUser {
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface ForgeAdapter {
  readonly kind: ForgeKind;
  getAuthenticatedUser(): Promise<AuthenticatedUser>;
  testConnection(branch?: string): Promise<RepoConnectionInfo>;
  getHeadSha(branch: string): Promise<string | null>;
  readBookmarkFiles(branch: string, rootDir: string): Promise<ReadBookmarkFilesResult>;
  commitChanges(input: CommitChangesInput): Promise<{ commitSha: string }>;
}

export interface ForgeAdapterConfig {
  forge: ForgeKind;
  instanceUrl?: string;
  owner: string;
  repo: string;
  token: string;
  fetchFn?: typeof fetch;
}

export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type GitHubDeviceTokenPollResult =
  | {
      status: 'authorized';
      accessToken: string;
      tokenType: string;
      scope: string;
      expiresIn?: number;
      refreshToken?: string;
      refreshTokenExpiresIn?: number;
    }
  | { status: 'pending'; interval?: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired'; message: string }
  | { status: 'access_denied'; message: string }
  | { status: 'error'; message: string };

export type GitHubTokenRefreshResult =
  | {
      status: 'refreshed';
      accessToken: string;
      tokenType: string;
      scope: string;
      expiresIn?: number;
      refreshToken?: string;
      refreshTokenExpiresIn?: number;
    }
  | { status: 'error'; errorCode?: string; message: string };
