import {
  SyncEngine,
  createForgeAdapter,
  generateId,
  type ProfileConfig,
  type SyncResult,
} from '@glyphrig/core';
import { browser } from 'wxt/browser';
import { applyTreeToBrowser, readBrowserSubtree } from './browser-tree.js';
import type { DryRunPreviewPayload, SyncLogEntry } from './messages.js';
import {
  appendConflicts,
  appendHistory,
  clearDirtyProfile,
  getProfiles,
  getSnapshots,
  saveProfiles,
  saveSnapshot,
} from './storage.js';

const DEBOUNCE_ALARM_PREFIX = 'glyphrig-debounce:';
const PULL_ALARM_PREFIX = 'glyphrig-pull:';

const activeLocks = new Map<string, Promise<unknown>>();
const echoDepth = new Map<string, number>();
const echoSuppressUntil = new Map<string, number>();

export function isEchoSuppressed(profileId: string): boolean {
  if ((echoDepth.get(profileId) ?? 0) > 0) return true;
  const until = echoSuppressUntil.get(profileId) ?? 0;
  return Date.now() < until;
}

function beginEchoSuppression(profileId: string): void {
  echoDepth.set(profileId, (echoDepth.get(profileId) ?? 0) + 1);
}

function endEchoSuppression(profileId: string): void {
  const next = Math.max(0, (echoDepth.get(profileId) ?? 1) - 1);
  echoDepth.set(profileId, next);
  // Grace window covers asynchronous browser.bookmarks events fired right after mutation resolves
  echoSuppressUntil.set(profileId, Date.now() + 750);
}

export async function scheduleDebouncedPush(
  profileId: string,
  delaySeconds = 60,
): Promise<void> {
  // Chrome MV3 enforces minimum 0.5 minutes on alarms in packaged builds
  const delayInMinutes = Math.max(0.5, delaySeconds / 60);
  await browser.alarms.create(`${DEBOUNCE_ALARM_PREFIX}${profileId}`, {
    delayInMinutes,
  });
}

export async function scheduleAllPeriodicAlarms(): Promise<void> {
  const allAlarms = await browser.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith(PULL_ALARM_PREFIX)) {
      await browser.alarms.clear(alarm.name);
    }
  }

  const profiles = await getProfiles();
  for (const profile of profiles) {
    if (!profile.enabled || !profile.autoSync) continue;
    const periodInMinutes = Math.max(1, profile.pullIntervalMinutes || 15);
    await browser.alarms.create(`${PULL_ALARM_PREFIX}${profile.id}`, {
      periodInMinutes,
    });
  }
}

export function parseAlarmName(
  name: string,
): { kind: 'debounce' | 'pull'; profileId: string } | null {
  if (name.startsWith(DEBOUNCE_ALARM_PREFIX)) {
    return {
      kind: 'debounce',
      profileId: name.slice(DEBOUNCE_ALARM_PREFIX.length),
    };
  }
  if (name.startsWith(PULL_ALARM_PREFIX)) {
    return {
      kind: 'pull',
      profileId: name.slice(PULL_ALARM_PREFIX.length),
    };
  }
  return null;
}

async function updateBadge(status: 'ok' | 'warning' | 'error', dirtyCount = 0): Promise<void> {
  if (!browser.action) return;
  try {
    if (status === 'error') {
      await browser.action.setBadgeText({ text: '!' });
      await browser.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } else if (status === 'warning') {
      await browser.action.setBadgeText({ text: '!' });
      await browser.action.setBadgeBackgroundColor({ color: '#d97706' });
    } else if (dirtyCount > 0) {
      await browser.action.setBadgeText({ text: String(dirtyCount) });
      await browser.action.setBadgeBackgroundColor({ color: '#b45309' });
    } else {
      await browser.action.setBadgeText({ text: '' });
    }
  } catch {
    // Ignore on platforms where action badge APIs are unavailable
  }
}

export async function refreshPendingBadge(profileId: string, dirtyCount: number): Promise<void> {
  const profiles = await getProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (profile?.enabled) {
    await updateBadge('ok', dirtyCount);
  }
}

async function withProfileLock<T>(
  profileId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = activeLocks.get(profileId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  activeLocks.set(profileId, run);
  try {
    return await run;
  } finally {
    if (activeLocks.get(profileId) === run) {
      activeLocks.delete(profileId);
    }
  }
}

function buildSyncSummaryMessage(result: SyncResult): string {
  const pushed =
    result.summary.addedBookmarks.length +
    result.summary.removedBookmarks.length +
    result.summary.updatedBookmarks.length +
    result.summary.movedBookmarks.length;
  const pulled =
    result.summary.remoteAddedBookmarks.length +
    result.summary.remoteRemovedBookmarks.length +
    result.summary.remoteUpdatedBookmarks.length +
    result.summary.remoteMovedBookmarks.length;

  if (!result.committed && !result.localPatchNeeded) {
    return 'Already up to date.';
  }
  const parts: string[] = [];
  if (pushed > 0 || result.committed) {
    parts.push(`pushed ${result.upserts.length + result.deletes.length} file change(s)`);
  }
  if (result.archivedCount > 0) {
    parts.push(`archived ${result.archivedCount} item(s)`);
  }
  if (pulled > 0 || result.localPatchNeeded) {
    parts.push(`updated browser folder (${pulled} link change(s))`);
  }
  return parts.join('; ') || 'Synced cleanly.';
}

async function executeSync(
  profile: ProfileConfig,
  dryRun: boolean,
  trigger: SyncLogEntry['trigger'],
): Promise<SyncResult> {
  if (!profile.token || !profile.owner || !profile.repo || !profile.rootFolderId) {
    throw new Error('Profile is missing repository credentials or bookmark folder.');
  }

  const adapter = createForgeAdapter({
    forge: profile.forge,
    instanceUrl: profile.instanceUrl,
    owner: profile.owner,
    repo: profile.repo,
    token: profile.token,
  });

  let currentUser = profile.username?.trim() || undefined;
  if (!currentUser) {
    try {
      const authUser = await adapter.getAuthenticatedUser();
      const fetched = authUser?.username?.trim();
      if (fetched) {
        currentUser = fetched;
        const profiles = await getProfiles();
        const idx = profiles.findIndex((p) => p.id === profile.id);
        if (idx >= 0) {
          const updated = [...profiles];
          updated[idx] = { ...updated[idx]!, username: fetched };
          await saveProfiles(updated);
        }
      }
    } catch {
      // Best-effort lookup; proceed with sync even if user endpoint is unavailable
    }
  }

  const snapshots = await getSnapshots();
  const snapshot = snapshots[profile.id] ?? null;
  const localTree = await readBrowserSubtree(profile.rootFolderId);

  const engine = new SyncEngine();
  const result = await engine.sync({
    adapter,
    branch: profile.branch || 'main',
    rootDir: profile.rootDir || 'bookmarks',
    localTree,
    snapshot,
    syncMode: profile.syncMode ?? 'two-way',
    currentUser,
    safety: profile.safety,
    dryRun,
  });

  if (dryRun) {
    return result;
  }

  if (result.localPatchNeeded) {
    await applyTreeToBrowser(profile.rootFolderId, result.browserTargetTree, {
      onStart: () => beginEchoSuppression(profile.id),
      onEnd: () => endEchoSuppression(profile.id),
    });
  }

  // Persist snapshot of sanitized local+remote merged tree
  await saveSnapshot(profile.id, result.snapshot);
  await clearDirtyProfile(profile.id);

  if (result.conflicts.length > 0) {
    await appendConflicts(result.conflicts);
  }

  const hasAlerts = result.skipped.length > 0 || result.conflicts.length > 0;
  const status: SyncLogEntry['status'] = hasAlerts ? 'warning' : 'ok';

  await appendHistory({
    id: generateId(),
    timestamp: new Date().toISOString(),
    profileId: profile.id,
    profileName: profile.name,
    trigger,
    status,
    commitSha: result.commitSha,
    message: buildSyncSummaryMessage(result),
    skippedCount: result.skipped.length,
    conflictCount: result.conflicts.length,
    ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
  });

  await updateBadge(status, 0);
  return result;
}

export async function runProfileDryRun(
  profileId: string,
): Promise<DryRunPreviewPayload> {
  return withProfileLock(profileId, async () => {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error('Sync profile not found.');
    }
    const result = await executeSync(profile, true, 'manual');
    return {
      profileId: profile.id,
      profileName: profile.name,
      commitSha: result.commitSha,
      remoteCommitNeeded: result.remoteCommitNeeded,
      localPatchNeeded: result.localPatchNeeded,
      summary: result.summary,
      skipped: result.skipped,
      conflicts: result.conflicts,
      upserts: result.upserts,
      deletes: result.deletes,
    };
  });
}

export async function runProfileSync(
  profileId: string,
  trigger: SyncLogEntry['trigger'],
): Promise<SyncResult> {
  return withProfileLock(profileId, async () => {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error('Sync profile not found.');
    }
    try {
      return await executeSync(profile, false, trigger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendHistory({
        id: generateId(),
        timestamp: new Date().toISOString(),
        profileId: profile.id,
        profileName: profile.name,
        trigger,
        status: 'error',
        message: msg,
        skippedCount: 0,
        conflictCount: 0,
      });
      await updateBadge('error', 0);
      throw err;
    }
  });
}
