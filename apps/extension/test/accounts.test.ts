import { DEFAULT_SAFETY_CONFIG, type ProfileConfig, type SharedGitHubAccount } from '@glyphrig/core';
import { describe, expect, it } from 'vitest';
import {
  countProfilesUsingAccount,
  findMatchingSharedAccount,
  normalizeGitHubInstance,
  resolveEffectiveProfile,
} from '../src/lib/accounts.js';

const baseProfile: ProfileConfig = {
  id: 'prof-1',
  name: 'Public Bookmarks',
  enabled: true,
  forge: 'github',
  owner: 'alex',
  repo: 'bookmarks',
  branch: 'main',
  rootDir: 'bookmarks',
  token: '',
  authMethod: 'device-flow',
  rootFolderId: '10',
  autoSync: true,
  pushDebounceSeconds: 60,
  pullIntervalMinutes: 15,
  safety: { ...DEFAULT_SAFETY_CONFIG },
};

const sampleAccount: SharedGitHubAccount = {
  id: 'acct-1',
  instanceUrl: 'https://github.com',
  username: 'AlexDev',
  token: 'ghu_shared_token',
  authMethod: 'device-flow',
  refreshToken: 'ghr_shared_refresh',
  tokenExpiresAt: '2026-11-25T00:00:00.000Z',
  refreshTokenExpiresAt: '2027-05-24T00:00:00.000Z',
  oauthClientId: 'Ov23liTest',
  updatedAt: '2026-11-24T12:00:00.000Z',
};

describe('shared GitHub account helpers', () => {
  it('normalizes GitHub instance URLs', () => {
    expect(normalizeGitHubInstance()).toBe('https://github.com');
    expect(normalizeGitHubInstance('   ')).toBe('https://github.com');
    expect(normalizeGitHubInstance('https://github.com/')).toBe('https://github.com');
    expect(normalizeGitHubInstance('https://ghe.internal.dev///')).toBe('https://ghe.internal.dev');
  });

  it('resolves linked shared account credentials and metadata onto a profile', () => {
    const linked: ProfileConfig = { ...baseProfile, accountId: 'acct-1' };
    const effective = resolveEffectiveProfile(linked, [sampleAccount]);

    expect(effective.token).toBe('ghu_shared_token');
    expect(effective.refreshToken).toBe('ghr_shared_refresh');
    expect(effective.tokenExpiresAt).toBe('2026-11-25T00:00:00.000Z');
    expect(effective.oauthClientId).toBe('Ov23liTest');
    expect(effective.username).toBe('AlexDev');
  });

  it('throws an actionable error when a linked shared account is missing', () => {
    const broken: ProfileConfig = { ...baseProfile, accountId: 'missing-id' };
    expect(() => resolveEffectiveProfile(broken, [sampleAccount])).toThrow(
      /Linked GitHub account was removed/i,
    );
  });

  it('passes unlinked PAT and non-GitHub profiles through unchanged', () => {
    const patProfile: ProfileConfig = {
      ...baseProfile,
      token: 'ghp_direct',
      authMethod: 'pat',
    };
    const gitlabProfile: ProfileConfig = {
      ...baseProfile,
      forge: 'gitlab',
      accountId: 'acct-1',
      token: 'glpat_123',
    };

    expect(resolveEffectiveProfile(patProfile, [sampleAccount])).toBe(patProfile);
    expect(resolveEffectiveProfile(gitlabProfile, [sampleAccount])).toBe(gitlabProfile);
  });

  it('matches shared accounts by id or normalized instance + username', () => {
    const enterpriseAccount: SharedGitHubAccount = {
      ...sampleAccount,
      id: 'acct-ghe',
      instanceUrl: 'https://ghe.example.com',
      username: 'AlexDev',
    };
    const accounts = [sampleAccount, enterpriseAccount];

    expect(findMatchingSharedAccount(accounts, { id: 'acct-ghe' })?.id).toBe('acct-ghe');
    expect(
      findMatchingSharedAccount(accounts, {
        instanceUrl: 'https://github.com/',
        username: 'alexdev',
      })?.id,
    ).toBe('acct-1');
    expect(
      findMatchingSharedAccount(accounts, {
        instanceUrl: 'https://ghe.example.com',
        username: 'ALEXDEV',
      })?.id,
    ).toBe('acct-ghe');
    expect(
      findMatchingSharedAccount(accounts, {
        instanceUrl: 'https://other.example.com',
        username: 'alexdev',
      }),
    ).toBeUndefined();
  });

  it('counts GitHub profiles linked to a shared account', () => {
    const profiles: ProfileConfig[] = [
      { ...baseProfile, id: 'p1', accountId: 'acct-1' },
      { ...baseProfile, id: 'p2', accountId: 'acct-1' },
      { ...baseProfile, id: 'p3', forge: 'gitlab', accountId: 'acct-1' },
      { ...baseProfile, id: 'p4', accountId: 'acct-2' },
    ];
    expect(countProfilesUsingAccount(profiles, 'acct-1')).toBe(2);
    expect(countProfilesUsingAccount(profiles, 'acct-2')).toBe(1);
    expect(countProfilesUsingAccount(profiles, 'acct-3')).toBe(0);
  });
});
