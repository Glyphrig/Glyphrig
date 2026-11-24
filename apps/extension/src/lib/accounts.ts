import type { ProfileConfig, SharedGitHubAccount } from '@glyphrig/core';

export function normalizeGitHubInstance(instanceUrl?: string): string {
  const clean = instanceUrl?.trim().replace(/\/+$/, '');
  return clean || 'https://github.com';
}

export function findMatchingSharedAccount(
  accounts: SharedGitHubAccount[],
  candidate: { id?: string; instanceUrl?: string; username?: string },
): SharedGitHubAccount | undefined {
  if (candidate.id) {
    const byId = accounts.find((a) => a.id === candidate.id);
    if (byId) return byId;
  }

  const targetInstance = normalizeGitHubInstance(candidate.instanceUrl);
  const targetUser = candidate.username?.trim().toLowerCase();
  if (!targetUser) return undefined;

  return accounts.find(
    (a) =>
      normalizeGitHubInstance(a.instanceUrl) === targetInstance &&
      a.username?.trim().toLowerCase() === targetUser,
  );
}

export function countProfilesUsingAccount(
  profiles: ProfileConfig[],
  accountId: string,
): number {
  return profiles.filter((p) => p.forge === 'github' && p.accountId === accountId).length;
}

export function resolveEffectiveProfile(
  profile: ProfileConfig,
  accounts: SharedGitHubAccount[],
): ProfileConfig {
  if (profile.forge !== 'github' || !profile.accountId) {
    return profile;
  }

  const account = accounts.find((a) => a.id === profile.accountId);
  if (!account) {
    throw new Error(
      'Linked GitHub account was removed. Open Glyphrig Settings to select or reconnect a GitHub account.',
    );
  }

  return {
    ...profile,
    token: account.token,
    authMethod: account.authMethod,
    refreshToken: account.refreshToken,
    tokenExpiresAt: account.tokenExpiresAt,
    refreshTokenExpiresAt: account.refreshTokenExpiresAt,
    oauthClientId: account.oauthClientId,
    username: account.username || profile.username,
  };
}
