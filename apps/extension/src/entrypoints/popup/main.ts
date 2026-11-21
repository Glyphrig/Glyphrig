import type { SyncResult } from '@glyphrig/core';
import { browser } from 'wxt/browser';
import type { ExtensionMessage, ExtensionStatePayload } from '../../lib/messages.js';

async function sendRpc<T>(message: ExtensionMessage): Promise<T> {
  const res = (await browser.runtime.sendMessage(message)) as {
    ok: boolean;
    data?: T;
    error?: string;
  };
  if (!res?.ok) {
    throw new Error(res?.error || 'Extension background request failed.');
  }
  return res.data as T;
}

const emptyState = document.getElementById('empty-state')!;
const profilePanel = document.getElementById('profile-panel')!;
const selectWrap = document.getElementById('profile-select-wrap')!;
const profileSelect = document.getElementById('profile-select') as HTMLSelectElement;
const repoLabel = document.getElementById('profile-repo')!;
const statusBadge = document.getElementById('status-badge')!;
const folderLabel = document.getElementById('folder-label')!;
const lastSyncLabel = document.getElementById('last-sync-label')!;
const previewNotice = document.getElementById('preview-notice')!;
const syncBtn = document.getElementById('btn-sync-now') as HTMLButtonElement;
const siteLink = document.getElementById('link-site') as HTMLAnchorElement;
const feedbackEl = document.getElementById('popup-feedback')!;

let currentState: ExtensionStatePayload | null = null;

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}

function render(state: ExtensionStatePayload): void {
  currentState = state;
  if (state.profiles.length === 0) {
    emptyState.hidden = false;
    profilePanel.hidden = true;
    return;
  }

  emptyState.hidden = true;
  profilePanel.hidden = false;

  if (state.profiles.length > 1) {
    selectWrap.hidden = false;
    profileSelect.innerHTML = '';
    for (const p of state.profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.selected = p.id === state.activeProfileId;
      profileSelect.append(opt);
    }
  } else {
    selectWrap.hidden = true;
  }

  const active =
    state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0]!;
  const snap = state.snapshots[active.id];
  const dirty = state.dirtyProfiles[active.id] ?? 0;
  const lastLog = state.history.find((h) => h.profileId === active.id);
  const needsPreview = !snap && active.safety.previewFirstSync;

  repoLabel.textContent = `${active.forge}: ${active.owner}/${active.repo}`;
  folderLabel.textContent = `Folder: ${active.rootFolderTitle || active.rootFolderId} -> ${active.rootDir}/`;
  lastSyncLabel.textContent = snap
    ? `Last sync: ${new Date(snap.lastSyncedAt).toLocaleString()}`
    : 'Never synced yet';

  previewNotice.hidden = !needsPreview;
  syncBtn.textContent = needsPreview ? 'Preview First Sync in Settings' : 'Sync Now';

  statusBadge.className = 'badge';
  if (dirty > 0) {
    statusBadge.textContent = `${dirty} pending`;
    statusBadge.classList.add('is-warn');
  } else if (lastLog?.status === 'error') {
    statusBadge.textContent = 'Error';
    statusBadge.classList.add('is-err');
  } else if (lastLog?.status === 'warning') {
    statusBadge.textContent = 'Warnings';
    statusBadge.classList.add('is-warn');
  } else if (snap) {
    statusBadge.textContent = 'Synced';
    statusBadge.classList.add('is-ok');
  } else {
    statusBadge.textContent = 'New';
  }

  if (active.siteUrl) {
    siteLink.href = active.siteUrl;
    siteLink.hidden = false;
  } else {
    siteLink.hidden = true;
  }
}

document.getElementById('btn-open-options')?.addEventListener('click', openOptions);
document.getElementById('btn-setup')?.addEventListener('click', openOptions);

profileSelect.addEventListener('change', async () => {
  const next = await sendRpc<ExtensionStatePayload>({
    type: 'SET_ACTIVE_PROFILE',
    profileId: profileSelect.value,
  });
  render(next);
});

syncBtn.addEventListener('click', async () => {
  const snapshotState = currentState;
  if (!snapshotState) return;
  const active =
    snapshotState.profiles.find((p) => p.id === snapshotState.activeProfileId) ??
    snapshotState.profiles[0];
  if (!active) return;

  const snap = snapshotState.snapshots[active.id];
  if (!snap && active.safety.previewFirstSync) {
    openOptions();
    return;
  }

  syncBtn.disabled = true;
  feedbackEl.textContent = 'Syncing with Git…';
  try {
    const res = await sendRpc<SyncResult>({
      type: 'RUN_SYNC',
      profileId: active.id,
      trigger: 'manual',
    });
    feedbackEl.textContent = res.committed
      ? `Synced (${res.commitSha?.slice(0, 7) ?? ''}).`
      : res.localPatchNeeded
        ? 'Pulled updates to browser folder.'
        : 'Already up to date.';
    render(await sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' }));
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Sync failed.';
  } finally {
    syncBtn.disabled = false;
  }
});

void sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' })
  .then(render)
  .catch((err) => {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Failed to load state.';
  });
