import type { ConflictRecord, ProfileConfig, SyncSnapshot } from '@glyphrig/core';
import { browser } from 'wxt/browser';
import type { SyncLogEntry } from './messages.js';

const STORAGE_KEYS = {
  profiles: 'glyphrig_profiles',
  activeProfileId: 'glyphrig_active_profile_id',
  snapshots: 'glyphrig_snapshots',
  history: 'glyphrig_history',
  conflicts: 'glyphrig_conflicts',
  dirtyProfiles: 'glyphrig_dirty_profiles',
  githubOAuthClientIdOverride: 'glyphrig_github_oauth_client_id',
} as const;

const MAX_LOG_ENTRIES = 100;

export async function getProfiles(): Promise<ProfileConfig[]> {
  const res = await browser.storage.local.get(STORAGE_KEYS.profiles);
  const val = res[STORAGE_KEYS.profiles];
  return Array.isArray(val) ? (val as ProfileConfig[]) : [];
}

export async function saveProfiles(profiles: ProfileConfig[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.profiles]: profiles });
}

export async function getActiveProfileId(): Promise<string | null> {
  const res = await browser.storage.local.get(STORAGE_KEYS.activeProfileId);
  const val = res[STORAGE_KEYS.activeProfileId];
  return typeof val === 'string' && val ? val : null;
}

export async function setActiveProfileId(profileId: string | null): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.activeProfileId]: profileId });
}

export async function getSnapshots(): Promise<Record<string, SyncSnapshot>> {
  const res = await browser.storage.local.get(STORAGE_KEYS.snapshots);
  const val = res[STORAGE_KEYS.snapshots];
  return val && typeof val === 'object' ? (val as Record<string, SyncSnapshot>) : {};
}

export async function saveSnapshot(
  profileId: string,
  snapshot: SyncSnapshot | null,
): Promise<void> {
  const all = await getSnapshots();
  if (snapshot) {
    all[profileId] = snapshot;
  } else {
    delete all[profileId];
  }
  await browser.storage.local.set({ [STORAGE_KEYS.snapshots]: all });
}

export async function getHistory(): Promise<SyncLogEntry[]> {
  const res = await browser.storage.local.get(STORAGE_KEYS.history);
  const val = res[STORAGE_KEYS.history];
  return Array.isArray(val) ? (val as SyncLogEntry[]) : [];
}

export async function appendHistory(entry: SyncLogEntry): Promise<void> {
  const list = await getHistory();
  const next = [entry, ...list].slice(0, MAX_LOG_ENTRIES);
  await browser.storage.local.set({ [STORAGE_KEYS.history]: next });
}

export async function getConflicts(): Promise<ConflictRecord[]> {
  const res = await browser.storage.local.get(STORAGE_KEYS.conflicts);
  const val = res[STORAGE_KEYS.conflicts];
  return Array.isArray(val) ? (val as ConflictRecord[]) : [];
}

export async function appendConflicts(records: ConflictRecord[]): Promise<void> {
  if (records.length === 0) return;
  const existing = await getConflicts();
  const next = [...records, ...existing].slice(0, MAX_LOG_ENTRIES);
  await browser.storage.local.set({ [STORAGE_KEYS.conflicts]: next });
}

export async function clearHistoryAndConflicts(): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.history]: [],
    [STORAGE_KEYS.conflicts]: [],
  });
}

export async function getDirtyProfiles(): Promise<Record<string, number>> {
  const res = await browser.storage.local.get(STORAGE_KEYS.dirtyProfiles);
  const val = res[STORAGE_KEYS.dirtyProfiles];
  return val && typeof val === 'object' ? (val as Record<string, number>) : {};
}

export async function incrementDirtyProfile(profileId: string): Promise<number> {
  const all = await getDirtyProfiles();
  const next = (all[profileId] ?? 0) + 1;
  all[profileId] = next;
  await browser.storage.local.set({ [STORAGE_KEYS.dirtyProfiles]: all });
  return next;
}

export async function clearDirtyProfile(profileId: string): Promise<void> {
  const all = await getDirtyProfiles();
  if (profileId in all) {
    delete all[profileId];
    await browser.storage.local.set({ [STORAGE_KEYS.dirtyProfiles]: all });
  }
}

export async function getGithubOAuthClientIdOverride(): Promise<string> {
  const res = await browser.storage.local.get(STORAGE_KEYS.githubOAuthClientIdOverride);
  const val = res[STORAGE_KEYS.githubOAuthClientIdOverride];
  return typeof val === 'string' ? val.trim() : '';
}

export async function setGithubOAuthClientIdOverride(clientId: string): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.githubOAuthClientIdOverride]: clientId.trim(),
  });
}

export async function getEffectiveGithubOAuthClientId(): Promise<string> {
  const override = await getGithubOAuthClientIdOverride();
  if (override) return override;
  return (import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID ?? '').trim();
}
