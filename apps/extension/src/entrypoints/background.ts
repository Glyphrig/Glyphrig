import {
  DEFAULT_SAFETY_CONFIG,
  ForgeError,
  createForgeAdapter,
  inspectUrlSafety,
  isPrivateOrLocalHostname,
  isSafeHttpUrl,
  normalizeUrl,
  parseGlyphrigManifest,
  pollGitHubDeviceToken,
  requestGitHubDeviceCode,
  type ProfileConfig,
} from '@glyphrig/core';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { resolveEffectiveProfile } from '../lib/accounts.js';
import {
  deleteBrowserBookmarkInPath,
  ensureBrowserBookmarkInPath,
  isDescendantOfFolder,
  listSelectableFolders,
  renameBrowserSubfolder,
} from '../lib/browser-tree.js';
import type {
  ExtensionMessage,
  ExtensionStatePayload,
  PageInspectionPayload,
  SaveAndAnnotateResult,
} from '../lib/messages.js';
import {
  collectSubfoldersFromSnapshot,
  collectTagsFromSnapshot,
  countUniqueCollaboratorsForUrl,
  findUrlMatchesAcrossProfiles,
  type ProfileSubfolderOption,
} from '../lib/page-match.js';
import {
  clearDirtyProfile,
  clearHistoryAndConflicts,
  clearPendingAnnotations,
  deleteSharedAccount,
  getActiveProfileId,
  getAllPendingAnnotations,
  getConflicts,
  getDirtyProfiles,
  getEffectiveGithubOAuthClientId,
  getGithubOAuthClientIdOverride,
  getHistory,
  getLivePageBadgeEnabled,
  getProfiles,
  getSharedAccounts,
  getSnapshots,
  incrementDirtyProfile,
  migrateLegacyDeviceFlowProfiles,
  saveSnapshot,
  setActiveProfileId,
  setGithubOAuthClientIdOverride,
  setLivePageBadgeEnabled,
  updateConflictRecord,
  updateProfiles,
  upsertPendingAnnotation,
  upsertSharedAccount,
} from '../lib/storage.js';
import {
  beginEchoSuppression,
  endEchoSuppression,
  ensureFreshGitHubProfile,
  getGlobalBadgeState,
  isEchoSuppressed,
  parseAlarmName,
  recomputeGlobalBadge,
  refreshPendingBadge,
  runProfileDryRun,
  runProfileSync,
  scheduleAllPeriodicAlarms,
  scheduleDebouncedPush,
} from '../lib/sync-runner.js';

const CONTEXT_MENU_SAVE_ID = 'glyphrig-save-page';
let contextMenuQueue: Promise<void> = Promise.resolve();

async function clearTabBadgeOverride(tabId: number): Promise<void> {
  if (!browser.action) return;
  try {
    await browser.action.setBadgeText({ tabId, text: null as unknown as string });
  } catch {
    try {
      await browser.action.setBadgeText({ tabId, text: '' });
    } catch {
      // ignore
    }
  }
}

async function updateLiveBadgeForTab(tabId: number, rawUrl?: string): Promise<void> {
  if (!browser.action) return;
  try {
    const enabled = await getLivePageBadgeEnabled();
    if (!enabled) {
      // Do not write per-tab badge overrides when live badge is disabled —
      // let the global error/pending badge shine through on every tab.
      return;
    }

    const { severity } = await getGlobalBadgeState();
    if (severity === 'error' || !rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      await clearTabBadgeOverride(tabId);
      return;
    }

    const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
    const matches = findUrlMatchesAcrossProfiles(rawUrl, profiles, snapshots);
    if (matches.length === 0) {
      await clearTabBadgeOverride(tabId);
      return;
    }
    const count = countUniqueCollaboratorsForUrl(matches);
    await browser.action.setBadgeText({ tabId, text: String(count) });
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#0f766e' });
  } catch {
    // Ignore on platforms where per-tab badge APIs are unavailable
  }
}

function registerContextMenu(): Promise<void> {
  contextMenuQueue = contextMenuQueue.then(async () => {
    try {
      if (!browser.contextMenus) return;
      await browser.contextMenus.removeAll();
      await new Promise<void>((resolve) => {
        try {
          browser.contextMenus.create(
            {
              id: CONTEXT_MENU_SAVE_ID,
              title: 'Save to Glyphrig Bookmarks',
              contexts: ['page', 'link'],
            },
            () => {
              // Access lastError if present to avoid unchecked runtime warnings
              void browser.runtime.lastError;
              resolve();
            },
          );
        } catch {
          resolve();
        }
      });
    } catch {
      // Ignore on mobile browsers without contextMenus
    }
  });
  return contextMenuQueue;
}

async function notifyProfilesForFolders(candidateFolderIds: Array<string | undefined>): Promise<void> {
  const uniqueIds = [...new Set(candidateFolderIds.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) return;

  const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
  for (const profile of profiles) {
    if (!profile.enabled || !profile.rootFolderId) continue;
    if (profile.syncMode === 'subscribe-only') continue;
    if (isEchoSuppressed(profile.id)) continue;

    let touched = false;
    for (const folderId of uniqueIds) {
      if (await isDescendantOfFolder(folderId, profile.rootFolderId)) {
        touched = true;
        break;
      }
    }
    if (!touched) continue;

    const dirtyCount = await incrementDirtyProfile(profile.id);
    await refreshPendingBadge(profile.id, dirtyCount);

    const hasSnapshot = Boolean(snapshots[profile.id]);
    if (profile.autoSync && (hasSnapshot || !profile.safety.previewFirstSync)) {
      await scheduleDebouncedPush(profile.id, profile.pushDebounceSeconds || 60);
    }
  }
}

async function runStartupPulls(): Promise<void> {
  const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
  for (const profile of profiles) {
    if (!profile.enabled || !profile.autoSync) continue;
    const hasSnapshot = Boolean(snapshots[profile.id]);
    if (
      !hasSnapshot &&
      profile.safety.previewFirstSync &&
      profile.syncMode !== 'subscribe-only'
    ) {
      continue;
    }
    await runProfileSync(profile.id, 'startup').catch(() => {});
  }
}

async function buildExtensionState(): Promise<ExtensionStatePayload> {
  await migrateLegacyDeviceFlowProfiles();
  const [
    profiles,
    sharedAccounts,
    activeProfileId,
    snapshots,
    history,
    conflicts,
    dirtyProfiles,
    pendingAnnotations,
    livePageBadgeEnabled,
    githubOAuthClientIdOverride,
    effectiveGithubOAuthClientId,
  ] = await Promise.all([
    getProfiles(),
    getSharedAccounts(),
    getActiveProfileId(),
    getSnapshots(),
    getHistory(),
    getConflicts(),
    getDirtyProfiles(),
    getAllPendingAnnotations(),
    getLivePageBadgeEnabled(),
    getGithubOAuthClientIdOverride(),
    getEffectiveGithubOAuthClientId(),
  ]);

  return {
    profiles,
    sharedAccounts,
    activeProfileId: activeProfileId ?? profiles[0]?.id ?? null,
    snapshots,
    history,
    conflicts,
    dirtyProfiles,
    pendingAnnotations,
    livePageBadgeEnabled,
    githubOAuthClientIdOverride,
    effectiveGithubOAuthClientId,
  };
}

async function handleMessage(msg: ExtensionMessage): Promise<unknown> {
  switch (msg.type) {
    case 'GET_STATE':
      return buildExtensionState();

    case 'SET_ACTIVE_PROFILE': {
      await setActiveProfileId(msg.profileId);
      return buildExtensionState();
    }

    case 'LIST_FOLDERS':
      return listSelectableFolders();

    case 'SAVE_PROFILE': {
      let targetChanged = false;
      await updateProfiles((profiles) => {
        const idx = profiles.findIndex((p) => p.id === msg.profile.id);
        const next = [...profiles];
        if (idx >= 0) {
          const prev = profiles[idx]!;
          next[idx] = msg.profile;
          // Clear snapshot + pending state if target repo, instance, branch, rootDir, folder, or syncMode changed
          if (
            prev.forge !== msg.profile.forge ||
            (prev.instanceUrl ?? '').trim() !== (msg.profile.instanceUrl ?? '').trim() ||
            prev.owner !== msg.profile.owner ||
            prev.repo !== msg.profile.repo ||
            prev.branch !== msg.profile.branch ||
            prev.rootDir !== msg.profile.rootDir ||
            prev.rootFolderId !== msg.profile.rootFolderId ||
            (prev.syncMode ?? 'two-way') !== (msg.profile.syncMode ?? 'two-way')
          ) {
            targetChanged = true;
          }
        } else {
          next.push(msg.profile);
        }
        return next;
      });
      if (targetChanged) {
        await Promise.all([
          saveSnapshot(msg.profile.id, null),
          clearDirtyProfile(msg.profile.id),
          clearPendingAnnotations(msg.profile.id),
        ]);
      }
      const active = await getActiveProfileId();
      if (!active) {
        await setActiveProfileId(msg.profile.id);
      }
      await scheduleAllPeriodicAlarms();
      await recomputeGlobalBadge();
      return buildExtensionState();
    }

    case 'DELETE_PROFILE': {
      const next = await updateProfiles((profiles) =>
        profiles.filter((p) => p.id !== msg.profileId),
      );
      await Promise.all([
        saveSnapshot(msg.profileId, null),
        clearDirtyProfile(msg.profileId),
        clearPendingAnnotations(msg.profileId),
      ]);
      const active = await getActiveProfileId();
      if (active === msg.profileId) {
        await setActiveProfileId(next[0]?.id ?? null);
      }
      await scheduleAllPeriodicAlarms();
      await recomputeGlobalBadge();
      return buildExtensionState();
    }

    case 'SAVE_SHARED_ACCOUNT': {
      await upsertSharedAccount(msg.account);
      return buildExtensionState();
    }

    case 'DELETE_SHARED_ACCOUNT': {
      await deleteSharedAccount(msg.accountId);
      await updateProfiles((profiles) =>
        profiles.map((p) => {
          if (p.accountId !== msg.accountId) return p;
          const copy = { ...p };
          delete copy.accountId;
          return copy;
        }),
      );
      return buildExtensionState();
    }

    case 'FETCH_GITHUB_USER': {
      const adapter = createForgeAdapter({
        forge: 'github',
        instanceUrl: msg.instanceUrl,
        owner: 'user',
        repo: 'repo',
        token: msg.token,
      });
      return adapter.getAuthenticatedUser();
    }

    case 'RUN_DRY_RUN':
      return runProfileDryRun(msg.profileId);

    case 'RUN_SYNC':
      return runProfileSync(msg.profileId, msg.trigger ?? 'manual');

    case 'RUN_SYNC_ALL': {
      const profiles = (await getProfiles()).filter((p) => p.enabled);
      let synced = 0;
      const failed: Array<{ profileId: string; name: string; error: string }> = [];
      for (const p of profiles) {
        try {
          await runProfileSync(p.id, 'manual');
          synced++;
        } catch (err) {
          failed.push({
            profileId: p.id,
            name: p.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { synced, failed };
    }

    case 'TEST_CONNECTION': {
      await migrateLegacyDeviceFlowProfiles();
      const [profiles, accounts] = await Promise.all([getProfiles(), getSharedAccounts()]);
      let token = msg.config.token;
      let tempProfile: ProfileConfig | undefined;

      if (msg.config.accountId) {
        const account = accounts.find((a) => a.id === msg.config.accountId);
        if (!account) {
          throw new Error('Selected GitHub account was not found.');
        }
        tempProfile = resolveEffectiveProfile(
          {
            id: msg.config.profileId || 'test-conn',
            name: 'test',
            enabled: true,
            forge: 'github',
            instanceUrl: msg.config.instanceUrl,
            owner: msg.config.owner,
            repo: msg.config.repo,
            branch: msg.config.branch,
            rootDir: 'bookmarks',
            accountId: account.id,
            token: '',
            rootFolderId: '1',
            autoSync: false,
            pushDebounceSeconds: 60,
            pullIntervalMinutes: 15,
            safety: { ...DEFAULT_SAFETY_CONFIG },
          },
          accounts,
        );
        tempProfile = await ensureFreshGitHubProfile(tempProfile, false);
        token = tempProfile.token;
      } else if (msg.config.profileId && msg.config.forge === 'github') {
        const saved = profiles.find((p) => p.id === msg.config.profileId);
        if (
          saved &&
          saved.forge === 'github' &&
          (saved.instanceUrl ?? '').trim() === (msg.config.instanceUrl ?? '').trim() &&
          saved.refreshToken &&
          saved.token === token
        ) {
          tempProfile = await ensureFreshGitHubProfile(saved, false);
          token = tempProfile.token;
        }
      }

      const runCheck = async (authToken: string) => {
        const adapter = createForgeAdapter({
          forge: msg.config.forge,
          instanceUrl: msg.config.instanceUrl,
          owner: msg.config.owner,
          repo: msg.config.repo,
          token: authToken,
        });
        const [info, user] = await Promise.all([
          adapter.testConnection(msg.config.branch),
          authToken.trim()
            ? adapter.getAuthenticatedUser().catch(() => null)
            : Promise.resolve(null),
        ]);
        return { ...info, ...(user ? { username: user.username } : {}) };
      };

      try {
        return await runCheck(token);
      } catch (err) {
        if (
          err instanceof ForgeError &&
          err.code === 'auth' &&
          tempProfile?.forge === 'github' &&
          tempProfile.refreshToken
        ) {
          tempProfile = await ensureFreshGitHubProfile(tempProfile, true);
          return await runCheck(tempProfile.token);
        }
        throw err;
      }
    }

    case 'START_GITHUB_DEVICE_FLOW': {
      const clientId =
        msg.clientId?.trim() || (await getEffectiveGithubOAuthClientId());
      if (!clientId) {
        throw new Error(
          'No GitHub OAuth Client ID configured. See About / OAuth Setup to add one or use a Personal Access Token.',
        );
      }
      const host = msg.instanceUrl?.trim() || 'https://github.com';
      return requestGitHubDeviceCode(clientId, 'repo', host);
    }

    case 'POLL_GITHUB_DEVICE_FLOW': {
      const clientId =
        msg.clientId?.trim() || (await getEffectiveGithubOAuthClientId());
      if (!clientId) {
        throw new Error('No GitHub OAuth Client ID configured.');
      }
      const host = msg.instanceUrl?.trim() || 'https://github.com';
      return pollGitHubDeviceToken(clientId, msg.deviceCode, host);
    }

    case 'SAVE_OAUTH_CLIENT_ID': {
      await setGithubOAuthClientIdOverride(msg.clientId);
      return buildExtensionState();
    }

    case 'CLEAR_HISTORY': {
      await clearHistoryAndConflicts();
      await recomputeGlobalBadge();
      return buildExtensionState();
    }

    case 'INSPECT_PAGE_URL': {
      const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
      const matches = findUrlMatchesAcrossProfiles(msg.url, profiles, snapshots);
      const tagsByProfile: Record<string, string[]> = {};
      const subfoldersByProfile: Record<string, ProfileSubfolderOption[]> = {};
      for (const p of profiles) {
        const snap = snapshots[p.id];
        tagsByProfile[p.id] = collectTagsFromSnapshot(snap);
        subfoldersByProfile[p.id] = collectSubfoldersFromSnapshot(
          snap,
          p.rootFolderTitle || p.name,
        );
      }
      const payload: PageInspectionPayload = {
        matches,
        tagsByProfile,
        subfoldersByProfile,
      };
      return payload;
    }

    case 'SAVE_AND_ANNOTATE_PAGE': {
      const profiles = await getProfiles();
      const profile = profiles.find((p) => p.id === msg.profileId);
      if (!profile) {
        throw new Error('Selected profile was not found.');
      }
      if (profile.syncMode === 'subscribe-only') {
        throw new Error(
          `"${profile.name}" is a read-only subscription. Pick a writable profile (Two-Way, Contribute-Only, or Propose PR).`,
        );
      }
      const safety = inspectUrlSafety(msg.url, profile.safety);
      if (!safety.allowed) {
        throw new Error(`Blocked by safety rails: ${safety.detail || safety.reason}`);
      }
      const cleanUrl = safety.cleanedUrl;
      const normUrl = normalizeUrl(cleanUrl, false);

      // Persist pending annotation BEFORE modifying browser bookmarks so any
      // concurrent or debounced sync never misses the user's note/tags.
      const hasRichMeta =
        Boolean(msg.note?.trim()) ||
        Boolean(msg.contributorNote?.trim()) ||
        msg.tags.length > 0;
      if (hasRichMeta) {
        await upsertPendingAnnotation(profile.id, {
          url: cleanUrl,
          normalizedUrl: normUrl,
          folderPath: msg.folderPath,
          title: msg.title.trim() || undefined,
          ...(msg.note?.trim() ? { note: msg.note.trim() } : {}),
          ...(msg.contributorNote?.trim()
            ? { contributorNote: msg.contributorNote.trim() }
            : {}),
          tags: msg.tags,
          updatedAt: new Date().toISOString(),
        });
      }

      const snaps = await getSnapshots();
      const willSyncNow = Boolean(
        msg.syncNow && (snaps[profile.id] || !profile.safety.previewFirstSync),
      );

      let savedToBrowser = false;
      if (profile.rootFolderId) {
        if (willSyncNow) {
          beginEchoSuppression(profile.id);
        }
        try {
          await ensureBrowserBookmarkInPath(
            profile.rootFolderId,
            msg.folderPath,
            msg.title || cleanUrl,
            cleanUrl,
          );
          savedToBrowser = true;
        } finally {
          if (willSyncNow) {
            endEchoSuppression(profile.id);
          }
        }
      }

      let syncResult;
      if (willSyncNow) {
        syncResult = await runProfileSync(profile.id, 'manual');
      }

      const result: SaveAndAnnotateResult = {
        savedToBrowser,
        ...(syncResult ? { syncResult } : {}),
        state: await buildExtensionState(),
      };
      return result;
    }

    case 'RESOLVE_CONFLICT': {
      const [conflicts, profiles] = await Promise.all([getConflicts(), getProfiles()]);
      const conflict = conflicts.find((c) => c.id === msg.conflictId);
      if (!conflict) {
        throw new Error('Conflict record not found.');
      }

      if (msg.choice === 'remote' || msg.choice === 'dismissed') {
        await updateConflictRecord(conflict.id, {
          resolved: true,
          resolvedChoice: msg.choice,
        });
        await recomputeGlobalBadge();
        return buildExtensionState();
      }

      const profile = conflict.profileId
        ? profiles.find((p) => p.id === conflict.profileId)
        : undefined;
      if (!profile) {
        throw new Error(
          'Cannot apply resolution: the profile that recorded this conflict no longer exists. Use Dismiss instead.',
        );
      }
      if (profile.syncMode === 'subscribe-only') {
        throw new Error(
          `"${profile.name}" is read-only (Subscribe-Only). Use Keep Theirs or Dismiss instead.`,
        );
      }
      if (!profile.rootFolderId) {
        throw new Error(`Profile "${profile.name}" has no browser bookmark folder linked.`);
      }

      const extractLegacyTitle = (summary: string): string =>
        summary
          .replace(/^(?:Modified|Updated|Edited|Renamed\s+folder\s+to)\s+"(.*)"(?:\s+in\s+.*)?$/i, '$1')
          .trim();

      beginEchoSuppression(profile.id);
      try {
        if (conflict.kind === 'folder-title-conflict') {
          const localTitle =
            conflict.localTitle?.trim() || extractLegacyTitle(conflict.localSummary);
          const remoteTitle =
            conflict.remoteTitle?.trim() || extractLegacyTitle(conflict.remoteSummary);
          const targetTitle =
            msg.choice === 'local'
              ? localTitle
              : remoteTitle && localTitle && remoteTitle !== localTitle
                ? `${remoteTitle} / ${localTitle}`.slice(0, 180)
                : localTitle || remoteTitle;
          if (!targetTitle) {
            throw new Error('Cannot determine target folder title for this conflict.');
          }
          const renamed = await renameBrowserSubfolder(
            profile.rootFolderId,
            conflict.folderPath || '',
            targetTitle,
          );
          if (!renamed) {
            throw new Error(`Folder "${conflict.folderPath || 'root'}" was not found in browser bookmarks.`);
          }
        } else if (conflict.kind === 'move-conflict') {
          if (!conflict.url) {
            throw new Error('Move conflict is missing bookmark URL.');
          }
          const localFolder = conflict.localFolderPath ?? '';
          const remoteFolder = conflict.remoteFolderPath ?? conflict.folderPath ?? '';
          const desiredTitle =
            conflict.localTitle?.trim() ||
            conflict.remoteTitle?.trim() ||
            conflict.url;
          if (msg.choice === 'local') {
            if (remoteFolder !== localFolder) {
              await deleteBrowserBookmarkInPath(
                profile.rootFolderId,
                remoteFolder,
                conflict.url,
              );
            }
            await ensureBrowserBookmarkInPath(
              profile.rootFolderId,
              localFolder,
              desiredTitle,
              conflict.url,
            );
          } else {
            // Merge Both: keep remote copy AND also ensure local folder copy exists
            await ensureBrowserBookmarkInPath(
              profile.rootFolderId,
              localFolder,
              desiredTitle,
              conflict.url,
            );
            await upsertPendingAnnotation(profile.id, {
              url: conflict.url,
              normalizedUrl: normalizeUrl(conflict.url, false),
              folderPath: localFolder,
              title: desiredTitle,
              contributorNote: `Merged move conflict (also kept in ${remoteFolder || 'root'})`,
              updatedAt: new Date().toISOString(),
            });
          }
        } else if (conflict.kind === 'edit-vs-delete') {
          if (!conflict.url) {
            throw new Error('Edit-vs-delete conflict is missing bookmark URL.');
          }
          const deletedSide =
            conflict.deletedSide ??
            (/deleted/i.test(conflict.localSummary) ? 'local' : 'remote');
          if (deletedSide === 'local') {
            if (msg.choice === 'local') {
              // User deleted locally while remote edited -> delete bookmark
              await deleteBrowserBookmarkInPath(
                profile.rootFolderId,
                conflict.remoteFolderPath ?? conflict.folderPath ?? '',
                conflict.url,
              );
            } else {
              // Merge Both: keep remote copy and record a note
              await upsertPendingAnnotation(profile.id, {
                url: conflict.url,
                normalizedUrl: normalizeUrl(conflict.url, false),
                folderPath: conflict.remoteFolderPath ?? conflict.folderPath ?? '',
                contributorNote: `Kept remote edit after local delete conflict`,
                updatedAt: new Date().toISOString(),
              });
            }
          } else {
            // Remote deleted while local edited -> restore local bookmark
            const restoreFolder = conflict.localFolderPath ?? conflict.folderPath ?? '';
            const restoreTitle =
              conflict.localTitle?.trim() ||
              extractLegacyTitle(conflict.localSummary) ||
              conflict.url;
            await ensureBrowserBookmarkInPath(
              profile.rootFolderId,
              restoreFolder,
              restoreTitle,
              conflict.url,
            );
            if (msg.choice === 'merged') {
              await upsertPendingAnnotation(profile.id, {
                url: conflict.url,
                normalizedUrl: normalizeUrl(conflict.url, false),
                folderPath: restoreFolder,
                title: restoreTitle,
                contributorNote: `Restored after remote delete conflict`,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        } else {
          // title-conflict
          if (!conflict.url) {
            throw new Error('Title conflict is missing bookmark URL.');
          }
          const localTitle =
            conflict.localTitle?.trim() || extractLegacyTitle(conflict.localSummary);
          const remoteTitle =
            conflict.remoteTitle?.trim() || extractLegacyTitle(conflict.remoteSummary);
          const targetFolder = conflict.remoteFolderPath ?? conflict.folderPath ?? '';
          const desiredTitle =
            msg.choice === 'local'
              ? localTitle || remoteTitle || conflict.url
              : remoteTitle || localTitle || conflict.url;

          await ensureBrowserBookmarkInPath(
            profile.rootFolderId,
            targetFolder,
            desiredTitle,
            conflict.url,
          );
          await upsertPendingAnnotation(profile.id, {
            url: conflict.url,
            normalizedUrl: normalizeUrl(conflict.url, false),
            folderPath: targetFolder,
            title: desiredTitle,
            ...(msg.choice === 'merged' && localTitle
              ? { contributorNote: `Alternate title: ${localTitle}` }
              : {}),
            updatedAt: new Date().toISOString(),
          });
        }
      } finally {
        endEchoSuppression(profile.id);
      }

      // Sync first; only mark conflict resolved if sync succeeds cleanly
      await runProfileSync(profile.id, 'manual');
      await updateConflictRecord(conflict.id, {
        resolved: true,
        resolvedChoice: msg.choice,
      });
      await recomputeGlobalBadge();
      return buildExtensionState();
    }

    case 'SET_LIVE_PAGE_BADGE': {
      await setLivePageBadgeEnabled(msg.enabled);
      if (!msg.enabled) {
        try {
          const allTabs = (await browser.tabs?.query({})) ?? [];
          for (const t of allTabs) {
            if (typeof t.id === 'number') {
              await clearTabBadgeOverride(t.id);
            }
          }
        } catch {
          // Ignore if tabs permission is not granted
        }
        await recomputeGlobalBadge();
      } else {
        try {
          const activeTabs = (await browser.tabs?.query({ active: true, currentWindow: true })) ?? [];
          const activeTab = activeTabs[0];
          if (typeof activeTab?.id === 'number') {
            await updateLiveBadgeForTab(activeTab.id, activeTab.url);
          }
        } catch {
          // Ignore if tabs permission is not granted
        }
      }
      return buildExtensionState();
    }

    case 'FETCH_GARDEN_MANIFEST': {
      if (!isSafeHttpUrl(msg.url)) {
        throw new Error('Garden URL must use http:// or https://.');
      }
      const parsedUrl = new URL(msg.url.trim());
      if (isPrivateOrLocalHostname(parsedUrl.hostname)) {
        throw new Error('Cannot fetch garden manifests from private or localhost addresses.');
      }
      const res = await fetch(parsedUrl.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`Could not load glyphrig.json (HTTP ${res.status}).`);
      }
      let raw: unknown;
      try {
        raw = (await res.json()) as unknown;
      } catch {
        throw new Error('The URL did not return valid JSON (expected glyphrig.json).');
      }
      const manifest = parseGlyphrigManifest(raw);
      if (!manifest) {
        throw new Error('The URL did not return a valid Glyphrig garden manifest (glyphrig.json).');
      }
      return manifest;
    }
  }
}

export default defineBackground(() => {
  if (browser.bookmarks) {
    browser.bookmarks.onCreated.addListener((_id, node) => {
      void notifyProfilesForFolders([node.parentId]);
    });

    browser.bookmarks.onChanged.addListener((id) => {
      void notifyProfilesForFolders([id]);
    });

    browser.bookmarks.onMoved.addListener((id, moveInfo) => {
      void notifyProfilesForFolders([id, moveInfo.parentId, moveInfo.oldParentId]);
    });

    browser.bookmarks.onRemoved.addListener((_id, removeInfo) => {
      void notifyProfilesForFolders([removeInfo.parentId]);
    });
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    const parsed = parseAlarmName(alarm.name);
    if (!parsed) return;
    void (async () => {
      const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
      const profile = profiles.find((p) => p.id === parsed.profileId);
      if (!profile || !profile.enabled) return;
      if (
        !snapshots[profile.id] &&
        profile.safety.previewFirstSync &&
        profile.syncMode !== 'subscribe-only'
      ) {
        return;
      }
      await runProfileSync(profile.id, parsed.kind === 'debounce' ? 'debounce' : 'alarm');
    })().catch(() => {});
  });

  browser.runtime.onInstalled.addListener(() => {
    void scheduleAllPeriodicAlarms();
    void registerContextMenu();
    void recomputeGlobalBadge();
  });

  browser.runtime.onStartup.addListener(() => {
    void scheduleAllPeriodicAlarms().then(() => runStartupPulls());
    void registerContextMenu();
    void recomputeGlobalBadge();
  });

  if (browser.contextMenus?.onClicked) {
    browser.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId !== CONTEXT_MENU_SAVE_ID) return;
      const targetUrl = info.linkUrl || info.pageUrl || tab?.url || '';
      const targetTitle = info.selectionText?.trim() || tab?.title || targetUrl;
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return;
      void (async () => {
        const [profiles, activeId] = await Promise.all([
          getProfiles(),
          getActiveProfileId(),
        ]);
        const targetProfile =
          profiles.find(
            (p) => p.id === activeId && p.enabled && p.syncMode !== 'subscribe-only',
          ) ?? profiles.find((p) => p.enabled && p.syncMode !== 'subscribe-only');
        if (!targetProfile?.rootFolderId) return;
        const safety = inspectUrlSafety(targetUrl, targetProfile.safety);
        if (!safety.allowed) return;
        await ensureBrowserBookmarkInPath(
          targetProfile.rootFolderId,
          '',
          targetTitle,
          safety.cleanedUrl,
        );
      })().catch(() => {});
    });
  }

  if (browser.tabs?.onActivated) {
    browser.tabs.onActivated.addListener(({ tabId }) => {
      void browser.tabs
        .get(tabId)
        .then((t) => updateLiveBadgeForTab(tabId, t.url))
        .catch(() => {});
    });
  }

  if (browser.tabs?.onUpdated) {
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.status === 'complete') {
        void updateLiveBadgeForTab(tabId, changeInfo.url || tab.url);
      }
    });
  }

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message as ExtensionMessage)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  });
});
