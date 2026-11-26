import {
  ForgeError,
  SyncEngine,
  createForgeAdapter,
  generateId,
  refreshGitHubDeviceToken,
  type ProfileConfig,
  type SyncResult,
} from '@glyphrig/core';
import { browser } from 'wxt/browser';
import { resolveEffectiveProfile } from './accounts.js';
import { applyTreeToBrowser, readBrowserSubtree } from './browser-tree.js';
import type { DryRunPreviewPayload, SyncLogEntry } from './messages.js';
import {
  appendConflicts,
  appendHistory,
  clearDirtyProfile,
  clearPendingAnnotations,
  getConflicts,
  getDirtyProfiles,
  getEffectiveGithubOAuthClientId,
  getHistory,
  getPendingAnnotations,
  getProfiles,
  getSharedAccounts,
  getSnapshots,
  saveSnapshot,
  updateProfiles,
  updateSharedAccounts,
} from './storage.js';

const DEBOUNCE_ALARM_PREFIX = 'glyphrig-debounce:';
const PULL_ALARM_PREFIX = 'glyphrig-pull:';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface RefreshedTokenPayload {
  token: string;
  refreshToken: string;
  oauthClientId: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

type RefreshTaskOutcome =
  | { status: 'refreshed'; payload: RefreshedTokenPayload }
  | { status: 'failed'; message: string };

const activeLocks = new Map<string, Promise<unknown>>();
const refreshInFlight = new Map<string, Promise<RefreshTaskOutcome>>();
const echoDepth = new Map<string, number>();
const echoSuppressUntil = new Map<string, number>();

function applyRefreshedTokensToProfile(
  profile: ProfileConfig,
  payload: RefreshedTokenPayload,
): ProfileConfig {
  const updated: ProfileConfig = {
    ...profile,
    token: payload.token,
    refreshToken: payload.refreshToken,
    oauthClientId: payload.oauthClientId,
  };
  if (payload.tokenExpiresAt) {
    updated.tokenExpiresAt = payload.tokenExpiresAt;
  } else {
    delete updated.tokenExpiresAt;
  }
  if (payload.refreshTokenExpiresAt) {
    updated.refreshTokenExpiresAt = payload.refreshTokenExpiresAt;
  }
  return updated;
}

export async function ensureFreshGitHubProfile(
  profile: ProfileConfig,
  forceRefresh = false,
): Promise<ProfileConfig> {
  if (profile.forge !== 'github' || !profile.refreshToken) {
    return profile;
  }

  const expiresMs = profile.tokenExpiresAt ? Date.parse(profile.tokenExpiresAt) : NaN;
  const isExpired = Number.isFinite(expiresMs) && expiresMs <= Date.now();
  const needsRefresh =
    forceRefresh || (Number.isFinite(expiresMs) && expiresMs - Date.now() <= TOKEN_EXPIRY_BUFFER_MS);

  if (!needsRefresh) {
    return profile;
  }

  const clientId =
    profile.oauthClientId?.trim() || (await getEffectiveGithubOAuthClientId());
  if (!clientId) {
    return profile;
  }

  const oldRefreshToken = profile.refreshToken;
  let task = refreshInFlight.get(oldRefreshToken);
  if (!task) {
    task = (async (): Promise<RefreshTaskOutcome> => {
      const res = await refreshGitHubDeviceToken(
        clientId,
        oldRefreshToken,
        profile.instanceUrl?.trim() || 'https://github.com',
      );

      if (res.status === 'refreshed') {
        const nextRefreshToken = res.refreshToken || oldRefreshToken;
        const tokenExpiresAt = res.expiresIn
          ? new Date(Date.now() + res.expiresIn * 1000).toISOString()
          : undefined;
        const refreshTokenExpiresAt = res.refreshTokenExpiresIn
          ? new Date(Date.now() + res.refreshTokenExpiresIn * 1000).toISOString()
          : profile.refreshTokenExpiresAt;

        const payload: RefreshedTokenPayload = {
          token: res.accessToken,
          refreshToken: nextRefreshToken,
          oauthClientId: clientId,
          ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
          ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
        };

        await updateSharedAccounts((sharedAccounts) =>
          sharedAccounts.map((acc) => {
            if (acc.id !== profile.accountId && acc.refreshToken !== oldRefreshToken) {
              return acc;
            }
            const nextAcc = {
              ...acc,
              token: payload.token,
              refreshToken: payload.refreshToken,
              oauthClientId: payload.oauthClientId,
              updatedAt: new Date().toISOString(),
            };
            if (payload.tokenExpiresAt) {
              nextAcc.tokenExpiresAt = payload.tokenExpiresAt;
            } else {
              delete nextAcc.tokenExpiresAt;
            }
            if (payload.refreshTokenExpiresAt) {
              nextAcc.refreshTokenExpiresAt = payload.refreshTokenExpiresAt;
            }
            return nextAcc;
          }),
        );

        await updateProfiles((profiles) =>
          profiles.map((p) => {
            if (p.accountId) {
              return p;
            }
            if (p.id !== profile.id && p.refreshToken !== oldRefreshToken) {
              return p;
            }
            return applyRefreshedTokensToProfile(p, payload);
          }),
        );

        return { status: 'refreshed', payload };
      }

      return { status: 'failed', message: res.message };
    })();

    refreshInFlight.set(oldRefreshToken, task);
    void task.finally(() => {
      if (refreshInFlight.get(oldRefreshToken) === task) {
        refreshInFlight.delete(oldRefreshToken);
      }
    });
  }

  const outcome = await task;
  if (outcome.status === 'refreshed') {
    return applyRefreshedTokensToProfile(profile, outcome.payload);
  }
  if (forceRefresh || isExpired) {
    throw new Error(
      `GitHub authorization expired (${outcome.message}). Open Glyphrig Settings and sign in with GitHub again.`,
    );
  }
  return profile;
}

export function isEchoSuppressed(profileId: string): boolean {
  if ((echoDepth.get(profileId) ?? 0) > 0) return true;
  const until = echoSuppressUntil.get(profileId) ?? 0;
  return Date.now() < until;
}

export function beginEchoSuppression(profileId: string): void {
  echoDepth.set(profileId, (echoDepth.get(profileId) ?? 0) + 1);
}

export function endEchoSuppression(profileId: string): void {
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

export type GlobalBadgeSeverity = 'error' | 'warning' | 'dirty' | 'ok';

export async function getGlobalBadgeState(): Promise<{
  severity: GlobalBadgeSeverity;
  dirtyCount: number;
}> {
  const [profiles, history, dirtyProfiles, conflicts] = await Promise.all([
    getProfiles(),
    getHistory(),
    getDirtyProfiles(),
    getConflicts(),
  ]);
  const enabledIds = new Set(profiles.filter((p) => p.enabled).map((p) => p.id));
  if (enabledIds.size === 0) {
    return { severity: 'ok', dirtyCount: 0 };
  }

  let hasError = false;
  let hasWarning = false;
  for (const id of enabledIds) {
    const latest = history.find((h) => h.profileId === id);
    if (latest?.status === 'error') {
      hasError = true;
      break;
    }
    if (latest?.status === 'warning') {
      hasWarning = true;
    }
  }
  if (hasError) {
    return { severity: 'error', dirtyCount: 0 };
  }

  let totalDirty = 0;
  for (const id of enabledIds) {
    totalDirty += dirtyProfiles[id] ?? 0;
  }
  if (totalDirty > 0) {
    return { severity: 'dirty', dirtyCount: totalDirty };
  }

  const hasUnresolvedConflict = conflicts.some(
    (c) => !c.resolved && (!c.profileId || enabledIds.has(c.profileId)),
  );
  if (hasWarning || hasUnresolvedConflict) {
    return { severity: 'warning', dirtyCount: 0 };
  }
  return { severity: 'ok', dirtyCount: 0 };
}

export async function recomputeGlobalBadge(): Promise<GlobalBadgeSeverity> {
  const { severity, dirtyCount } = await getGlobalBadgeState();
  if (!browser.action) return severity;
  try {
    if (severity === 'error') {
      await browser.action.setBadgeText({ text: '!' });
      await browser.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } else if (severity === 'dirty') {
      await browser.action.setBadgeText({ text: String(dirtyCount) });
      await browser.action.setBadgeBackgroundColor({ color: '#b45309' });
    } else if (severity === 'warning') {
      await browser.action.setBadgeText({ text: '!' });
      await browser.action.setBadgeBackgroundColor({ color: '#d97706' });
    } else {
      await browser.action.setBadgeText({ text: '' });
    }
  } catch {
    // Ignore on platforms where action badge APIs are unavailable
  }
  return severity;
}

export async function refreshPendingBadge(_profileId?: string, _dirtyCount?: number): Promise<void> {
  await recomputeGlobalBadge();
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
  if (result.pullRequestUrl) {
    parts.push(
      `proposed PR${result.pullRequestNumber ? ` #${result.pullRequestNumber}` : ''} (${result.upserts.length + result.deletes.length} file change(s))`,
    );
  } else if (pushed > 0 || result.committed) {
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
  const resolvedProfile = resolveEffectiveProfile(profile, await getSharedAccounts());
  const syncMode = resolvedProfile.syncMode ?? 'two-way';
  const requiresToken = syncMode !== 'subscribe-only';

  if (
    (requiresToken && !resolvedProfile.token) ||
    !resolvedProfile.owner ||
    !resolvedProfile.repo ||
    !resolvedProfile.rootFolderId
  ) {
    throw new Error('Profile is missing repository credentials or bookmark folder.');
  }

  let activeProfile = resolvedProfile.token
    ? await ensureFreshGitHubProfile(resolvedProfile, false)
    : resolvedProfile;
  const [snapshots, pendingAnnotations] = await Promise.all([
    getSnapshots(),
    getPendingAnnotations(activeProfile.id),
  ]);
  const snapshot = snapshots[activeProfile.id] ?? null;
  const localTree = await readBrowserSubtree(activeProfile.rootFolderId);

  const runSyncAttempt = async (targetProfile: ProfileConfig): Promise<SyncResult> => {
    const adapter = createForgeAdapter({
      forge: targetProfile.forge,
      instanceUrl: targetProfile.instanceUrl,
      owner: targetProfile.owner,
      repo: targetProfile.repo,
      token: targetProfile.token,
    });

    let currentUser = targetProfile.username?.trim() || undefined;
    if (!currentUser && targetProfile.token) {
      try {
        const authUser = await adapter.getAuthenticatedUser();
        const fetched = authUser?.username?.trim();
        if (fetched) {
          currentUser = fetched;
          await updateProfiles((profiles) =>
            profiles.map((p) =>
              p.id === targetProfile.id ? { ...p, username: fetched } : p,
            ),
          );
          if (targetProfile.accountId) {
            await updateSharedAccounts((accounts) =>
              accounts.map((acc) =>
                acc.id === targetProfile.accountId && !acc.username
                  ? {
                      ...acc,
                      username: fetched,
                      ...(authUser.displayName
                        ? { displayName: authUser.displayName }
                        : {}),
                    }
                  : acc,
              ),
            );
          }
        }
      } catch {
        // Best-effort lookup; proceed with sync even if user endpoint is unavailable
      }
    }

    const engine = new SyncEngine();
    return engine.sync({
      adapter,
      branch: targetProfile.branch || 'main',
      rootDir: targetProfile.rootDir || 'bookmarks',
      localTree,
      snapshot,
      syncMode,
      currentUser,
      safety: targetProfile.safety,
      localAnnotations: pendingAnnotations,
      dryRun,
    });
  };

  let result: SyncResult;
  try {
    result = await runSyncAttempt(activeProfile);
  } catch (err) {
    if (
      err instanceof ForgeError &&
      err.code === 'auth' &&
      activeProfile.forge === 'github' &&
      activeProfile.refreshToken
    ) {
      activeProfile = await ensureFreshGitHubProfile(activeProfile, true);
      result = await runSyncAttempt(activeProfile);
    } else if (
      err instanceof ForgeError &&
      err.code === 'auth' &&
      activeProfile.forge === 'github' &&
      activeProfile.authMethod === 'device-flow'
    ) {
      throw new Error(
        `GitHub authentication failed (${err.message}). Your token may have expired or been revoked — open Glyphrig Settings and click "Sign in with GitHub" to reconnect.`,
      );
    } else {
      throw err;
    }
  }

  if (dryRun) {
    return result;
  }

  if (result.localPatchNeeded) {
    await applyTreeToBrowser(activeProfile.rootFolderId, result.browserTargetTree, {
      onStart: () => beginEchoSuppression(activeProfile.id),
      onEnd: () => endEchoSuppression(activeProfile.id),
    });
  }

  // Persist snapshot of sanitized local+remote merged tree
  await saveSnapshot(activeProfile.id, result.snapshot);
  await clearDirtyProfile(activeProfile.id);
  await browser.alarms?.clear(`${DEBOUNCE_ALARM_PREFIX}${activeProfile.id}`).catch(() => {});
  if (pendingAnnotations.length > 0) {
    await clearPendingAnnotations(activeProfile.id, pendingAnnotations);
  }

  if (result.conflicts.length > 0) {
    await appendConflicts(
      result.conflicts.map((c) => ({ ...c, profileId: activeProfile.id })),
    );
  }

  const hasAlerts = result.skipped.length > 0 || result.conflicts.length > 0;
  const status: SyncLogEntry['status'] = hasAlerts ? 'warning' : 'ok';

  await appendHistory({
    id: generateId(),
    timestamp: new Date().toISOString(),
    profileId: activeProfile.id,
    profileName: activeProfile.name,
    trigger,
    status,
    commitSha: result.commitSha,
    ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
    ...(result.pullRequestNumber !== undefined
      ? { pullRequestNumber: result.pullRequestNumber }
      : {}),
    message: buildSyncSummaryMessage(result),
    skippedCount: result.skipped.length,
    conflictCount: result.conflicts.length,
    ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
  });

  await recomputeGlobalBadge();
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
      await recomputeGlobalBadge();
      throw err;
    }
  });
}
