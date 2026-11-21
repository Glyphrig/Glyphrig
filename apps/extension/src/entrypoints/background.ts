import { createForgeAdapter, pollGitHubDeviceToken, requestGitHubDeviceCode } from '@glyphrig/core';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { isDescendantOfFolder, listSelectableFolders } from '../lib/browser-tree.js';
import type { ExtensionMessage, ExtensionStatePayload } from '../lib/messages.js';
import {
  clearHistoryAndConflicts,
  getActiveProfileId,
  getConflicts,
  getDirtyProfiles,
  getEffectiveGithubOAuthClientId,
  getGithubOAuthClientIdOverride,
  getHistory,
  getProfiles,
  getSnapshots,
  incrementDirtyProfile,
  saveProfiles,
  saveSnapshot,
  setActiveProfileId,
  setGithubOAuthClientIdOverride,
} from '../lib/storage.js';
import {
  isEchoSuppressed,
  parseAlarmName,
  refreshPendingBadge,
  runProfileDryRun,
  runProfileSync,
  scheduleAllPeriodicAlarms,
  scheduleDebouncedPush,
} from '../lib/sync-runner.js';

async function notifyProfilesForFolders(candidateFolderIds: Array<string | undefined>): Promise<void> {
  const uniqueIds = [...new Set(candidateFolderIds.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) return;

  const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
  for (const profile of profiles) {
    if (!profile.enabled || !profile.rootFolderId) continue;
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
    if (!hasSnapshot && profile.safety.previewFirstSync) continue;
    runProfileSync(profile.id, 'startup').catch(() => {});
  }
}

async function buildExtensionState(): Promise<ExtensionStatePayload> {
  const [
    profiles,
    activeProfileId,
    snapshots,
    history,
    conflicts,
    dirtyProfiles,
    githubOAuthClientIdOverride,
    effectiveGithubOAuthClientId,
  ] = await Promise.all([
    getProfiles(),
    getActiveProfileId(),
    getSnapshots(),
    getHistory(),
    getConflicts(),
    getDirtyProfiles(),
    getGithubOAuthClientIdOverride(),
    getEffectiveGithubOAuthClientId(),
  ]);

  return {
    profiles,
    activeProfileId: activeProfileId ?? profiles[0]?.id ?? null,
    snapshots,
    history,
    conflicts,
    dirtyProfiles,
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
      const profiles = await getProfiles();
      const idx = profiles.findIndex((p) => p.id === msg.profile.id);
      const next = [...profiles];
      if (idx >= 0) {
        const prev = profiles[idx]!;
        next[idx] = msg.profile;
        // Clear snapshot if target repo, branch, rootDir, browser folder, or syncMode changed
        if (
          prev.forge !== msg.profile.forge ||
          prev.owner !== msg.profile.owner ||
          prev.repo !== msg.profile.repo ||
          prev.branch !== msg.profile.branch ||
          prev.rootDir !== msg.profile.rootDir ||
          prev.rootFolderId !== msg.profile.rootFolderId ||
          (prev.syncMode ?? 'two-way') !== (msg.profile.syncMode ?? 'two-way')
        ) {
          await saveSnapshot(msg.profile.id, null);
        }
      } else {
        next.push(msg.profile);
      }
      await saveProfiles(next);
      const active = await getActiveProfileId();
      if (!active) {
        await setActiveProfileId(msg.profile.id);
      }
      await scheduleAllPeriodicAlarms();
      return buildExtensionState();
    }

    case 'DELETE_PROFILE': {
      const profiles = await getProfiles();
      const next = profiles.filter((p) => p.id !== msg.profileId);
      await saveProfiles(next);
      await saveSnapshot(msg.profileId, null);
      const active = await getActiveProfileId();
      if (active === msg.profileId) {
        await setActiveProfileId(next[0]?.id ?? null);
      }
      await scheduleAllPeriodicAlarms();
      return buildExtensionState();
    }

    case 'RUN_DRY_RUN':
      return runProfileDryRun(msg.profileId);

    case 'RUN_SYNC':
      return runProfileSync(msg.profileId, msg.trigger ?? 'manual');

    case 'TEST_CONNECTION': {
      const adapter = createForgeAdapter({
        forge: msg.config.forge,
        instanceUrl: msg.config.instanceUrl,
        owner: msg.config.owner,
        repo: msg.config.repo,
        token: msg.config.token,
      });
      const [info, user] = await Promise.all([
        adapter.testConnection(msg.config.branch),
        adapter.getAuthenticatedUser().catch(() => null),
      ]);
      return { ...info, ...(user ? { username: user.username } : {}) };
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
      return buildExtensionState();
    }
  }
}

export default defineBackground(() => {
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

  browser.alarms.onAlarm.addListener((alarm) => {
    const parsed = parseAlarmName(alarm.name);
    if (!parsed) return;
    void (async () => {
      const [profiles, snapshots] = await Promise.all([getProfiles(), getSnapshots()]);
      const profile = profiles.find((p) => p.id === parsed.profileId);
      if (!profile || !profile.enabled) return;
      if (!snapshots[profile.id] && profile.safety.previewFirstSync) return;
      await runProfileSync(profile.id, parsed.kind === 'debounce' ? 'debounce' : 'alarm');
    })().catch(() => {});
  });

  browser.runtime.onInstalled.addListener(() => {
    void scheduleAllPeriodicAlarms();
  });

  browser.runtime.onStartup.addListener(() => {
    void scheduleAllPeriodicAlarms().then(() => runStartupPulls());
  });

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
