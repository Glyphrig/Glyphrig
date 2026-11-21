import {
  DEFAULT_SAFETY_CONFIG,
  generateId,
  type ForgeKind,
  type GitHubDeviceCodeResponse,
  type GitHubDeviceTokenPollResult,
  type ProfileConfig,
  type SyncResult,
} from '@glyphrig/core';
import { browser } from 'wxt/browser';
import type {
  DryRunPreviewPayload,
  ExtensionMessage,
  ExtensionStatePayload,
  SelectableFolderNode,
} from '../../lib/messages.js';

async function sendRpc<T>(message: ExtensionMessage): Promise<T> {
  const res = (await browser.runtime.sendMessage(message)) as {
    ok: boolean;
    data?: T;
    error?: string;
  };
  if (!res?.ok) {
    throw new Error(res?.error || 'Background communication error.');
  }
  return res.data as T;
}

function defaultInstancePlaceholder(forge: ForgeKind): string {
  switch (forge) {
    case 'github':
      return 'https://github.com (leave empty for github.com)';
    case 'gitlab':
      return 'https://gitlab.com';
    case 'forgejo':
      return 'https://codeberg.org';
  }
}

function tokenHintForForge(forge: ForgeKind): string {
  switch (forge) {
    case 'github':
      return 'GitHub Fine-grained PAT with Contents: Read and write (or sign in via Device Flow above).';
    case 'gitlab':
      return 'GitLab Project or Personal Access Token with "write_repository" scope.';
    case 'forgejo':
      return 'Codeberg / Forgejo / Gitea Access Token with "repository:write" scope.';
  }
}

async function ensureOriginPermission(instanceUrl?: string): Promise<void> {
  const clean = instanceUrl?.trim();
  if (!clean) return;
  try {
    const u = new URL(clean);
    const originPattern = `${u.origin}/*`;
    const builtInOrigins = [
      'https://api.github.com/*',
      'https://github.com/*',
      'https://gitlab.com/*',
      'https://codeberg.org/*',
    ];
    if (builtInOrigins.includes(originPattern)) return;
    const has = await browser.permissions.contains({ origins: [originPattern] });
    if (!has) {
      await browser.permissions.request({ origins: [originPattern] });
    }
  } catch {
    // Ignore permission prompt failures on browsers where optional permissions are auto-granted
  }
}

const form = document.getElementById('profile-form') as HTMLFormElement;
const profileListEl = document.getElementById('profile-list')!;
const deleteBtn = document.getElementById('btn-delete-profile') as HTMLButtonElement;
const formHeading = document.getElementById('form-heading')!;
const feedbackEl = document.getElementById('form-feedback')!;
const folderPickerEl = document.getElementById('folder-picker')!;
const selectedFolderDisplay = document.getElementById('selected-folder-display')!;
const connStatusEl = document.getElementById('conn-status')!;

const nameInput = document.getElementById('f-name') as HTMLInputElement;
const forgeSelect = document.getElementById('f-forge') as HTMLSelectElement;
const ownerInput = document.getElementById('f-owner') as HTMLInputElement;
const repoInput = document.getElementById('f-repo') as HTMLInputElement;
const branchInput = document.getElementById('f-branch') as HTMLInputElement;
const rootDirInput = document.getElementById('f-rootdir') as HTMLInputElement;
const instanceInput = document.getElementById('f-instance') as HTMLInputElement;
const siteUrlInput = document.getElementById('f-siteurl') as HTMLInputElement;
const tokenInput = document.getElementById('f-token') as HTMLInputElement;
const tokenHintEl = document.getElementById('token-scope-hint')!;
const githubDeviceBox = document.getElementById('github-device-box')!;
const deviceLoginBtn = document.getElementById('btn-device-login') as HTMLButtonElement;
const devicePendingBox = document.getElementById('device-pending')!;
const deviceCodeEl = document.getElementById('device-user-code')!;
const deviceVerifyLink = document.getElementById('device-verify-link') as HTMLAnchorElement;
const devicePollStatus = document.getElementById('device-poll-status')!;

const enabledCheck = document.getElementById('f-enabled') as HTMLInputElement;
const autoSyncCheck = document.getElementById('f-autosync') as HTMLInputElement;
const debounceInput = document.getElementById('f-debounce') as HTMLInputElement;
const pullMinInput = document.getElementById('f-pull-min') as HTMLInputElement;
const safetyPrivateCheck = document.getElementById('s-private') as HTMLInputElement;
const safetyCredsCheck = document.getElementById('s-creds') as HTMLInputElement;
const safetyTrackingCheck = document.getElementById('s-tracking') as HTMLInputElement;
const safetyPreviewCheck = document.getElementById('s-preview') as HTMLInputElement;

const effectiveClientIdEl = document.getElementById('effective-client-id')!;
const oauthOverrideInput = document.getElementById('oauth-override-input') as HTMLInputElement;
const oauthSaveStatusEl = document.getElementById('oauth-save-status')!;

const conflictsListEl = document.getElementById('conflicts-list')!;
const historyListEl = document.getElementById('history-list')!;

const previewModal = document.getElementById('dry-run-modal') as HTMLDialogElement;
const previewBodyEl = document.getElementById('dry-run-body')!;
const confirmPreviewBtn = document.getElementById('btn-confirm-preview') as HTMLButtonElement;

let state: ExtensionStatePayload | null = null;
let folders: SelectableFolderNode[] = [];
let editingProfileId: string | null = null;
let selectedFolderId = '';
let selectedFolderTitle = '';
let authMethod: 'pat' | 'device-flow' = 'pat';
let pendingPreviewProfileId: string | null = null;
let activePollTimer: number | undefined;

function stopDevicePoll(): void {
  if (activePollTimer !== undefined) {
    window.clearTimeout(activePollTimer);
    activePollTimer = undefined;
  }
}

function updateForgeUi(): void {
  const forge = forgeSelect.value as ForgeKind;
  instanceInput.placeholder = defaultInstancePlaceholder(forge);
  tokenHintEl.textContent = tokenHintForForge(forge);
  githubDeviceBox.hidden = forge !== 'github';
}

function renderFolderPicker(): void {
  folderPickerEl.innerHTML = '';
  if (folders.length === 0) {
    folderPickerEl.textContent = 'No bookmark folders available.';
    return;
  }

  for (const folder of folders) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folder-option';
    if (folder.id === selectedFolderId) {
      btn.classList.add('is-selected');
    }
    btn.disabled = !folder.selectable;
    btn.style.paddingLeft = `${10 + folder.depth * 18}px`;

    const labelSpan = document.createElement('span');
    labelSpan.textContent = folder.title;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'small muted';
    metaSpan.textContent = folder.selectable
      ? `${folder.childCount} item${folder.childCount === 1 ? '' : 's'}`
      : 'Root (pick subfolder)';

    btn.append(labelSpan, metaSpan);
    if (folder.selectable) {
      btn.addEventListener('click', () => {
        selectedFolderId = folder.id;
        selectedFolderTitle = folder.title;
        selectedFolderDisplay.textContent = `Selected: ${folder.title}`;
        renderFolderPicker();
      });
    }
    folderPickerEl.append(btn);
  }

  const matched = folders.find((f) => f.id === selectedFolderId);
  selectedFolderDisplay.textContent = matched
    ? `Selected: ${matched.title}`
    : selectedFolderId
      ? `Selected ID: ${selectedFolderId}`
      : 'No folder selected';
}

function loadProfileIntoForm(profile: ProfileConfig | null): void {
  stopDevicePoll();
  devicePendingBox.hidden = true;
  connStatusEl.textContent = '';
  feedbackEl.textContent = '';

  if (!profile) {
    editingProfileId = null;
    formHeading.textContent = 'New Sync Profile';
    deleteBtn.hidden = true;
    nameInput.value = 'Public Bookmarks';
    forgeSelect.value = 'github';
    ownerInput.value = '';
    repoInput.value = '';
    branchInput.value = 'main';
    rootDirInput.value = 'bookmarks';
    instanceInput.value = '';
    siteUrlInput.value = '';
    tokenInput.value = '';
    authMethod = 'pat';
    selectedFolderId = '';
    selectedFolderTitle = '';
    enabledCheck.checked = true;
    autoSyncCheck.checked = true;
    debounceInput.value = '60';
    pullMinInput.value = '15';
    safetyPrivateCheck.checked = DEFAULT_SAFETY_CONFIG.filterPrivateUrls;
    safetyCredsCheck.checked = DEFAULT_SAFETY_CONFIG.filterCredentials;
    safetyTrackingCheck.checked = DEFAULT_SAFETY_CONFIG.stripTrackingParams;
    safetyPreviewCheck.checked = DEFAULT_SAFETY_CONFIG.previewFirstSync;
  } else {
    editingProfileId = profile.id;
    formHeading.textContent = `Edit: ${profile.name}`;
    deleteBtn.hidden = false;
    nameInput.value = profile.name;
    forgeSelect.value = profile.forge;
    ownerInput.value = profile.owner;
    repoInput.value = profile.repo;
    branchInput.value = profile.branch || 'main';
    rootDirInput.value = profile.rootDir || 'bookmarks';
    instanceInput.value = profile.instanceUrl ?? '';
    siteUrlInput.value = profile.siteUrl ?? '';
    tokenInput.value = profile.token;
    authMethod = profile.authMethod ?? 'pat';
    selectedFolderId = profile.rootFolderId;
    selectedFolderTitle = profile.rootFolderTitle ?? '';
    enabledCheck.checked = profile.enabled;
    autoSyncCheck.checked = profile.autoSync;
    debounceInput.value = String(profile.pushDebounceSeconds || 60);
    pullMinInput.value = String(profile.pullIntervalMinutes || 15);
    safetyPrivateCheck.checked = profile.safety.filterPrivateUrls;
    safetyCredsCheck.checked = profile.safety.filterCredentials;
    safetyTrackingCheck.checked = profile.safety.stripTrackingParams;
    safetyPreviewCheck.checked = profile.safety.previewFirstSync;
  }
  updateForgeUi();
  renderFolderPicker();
}

function buildProfileFromForm(): ProfileConfig {
  if (!selectedFolderId) {
    throw new Error('Please choose a bookmark folder to sync.');
  }
  return {
    id: editingProfileId ?? generateId(),
    name: nameInput.value.trim() || 'Bookmarks',
    enabled: enabledCheck.checked,
    forge: forgeSelect.value as ForgeKind,
    ...(instanceInput.value.trim() ? { instanceUrl: instanceInput.value.trim() } : {}),
    owner: ownerInput.value.trim(),
    repo: repoInput.value.trim(),
    branch: branchInput.value.trim() || 'main',
    rootDir: rootDirInput.value.trim() || 'bookmarks',
    token: tokenInput.value.trim(),
    authMethod,
    rootFolderId: selectedFolderId,
    ...(selectedFolderTitle ? { rootFolderTitle: selectedFolderTitle } : {}),
    ...(siteUrlInput.value.trim() ? { siteUrl: siteUrlInput.value.trim() } : {}),
    autoSync: autoSyncCheck.checked,
    pushDebounceSeconds: Math.max(30, Number(debounceInput.value) || 60),
    pullIntervalMinutes: Math.max(1, Number(pullMinInput.value) || 15),
    safety: {
      filterPrivateUrls: safetyPrivateCheck.checked,
      filterCredentials: safetyCredsCheck.checked,
      stripTrackingParams: safetyTrackingCheck.checked,
      previewFirstSync: safetyPreviewCheck.checked,
    },
  };
}

function renderState(): void {
  if (!state) return;
  profileListEl.innerHTML = '';

  if (state.profiles.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'No profiles yet.';
    profileListEl.append(li);
  } else {
    for (const p of state.profiles) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'profile-item-btn';
      if (p.id === editingProfileId) btn.classList.add('is-active');
      const strong = document.createElement('strong');
      strong.textContent = p.name;
      const sub = document.createElement('span');
      sub.className = 'small muted';
      sub.textContent = `${p.forge}: ${p.owner}/${p.repo}`;
      btn.append(strong, sub);
      btn.addEventListener('click', () => {
        loadProfileIntoForm(p);
        renderState();
      });
      li.append(btn);
      profileListEl.append(li);
    }
  }

  effectiveClientIdEl.textContent = state.effectiveGithubOAuthClientId || 'not configured';
  oauthOverrideInput.value = state.githubOAuthClientIdOverride;

  conflictsListEl.innerHTML = '';
  if (state.conflicts.length === 0) {
    conflictsListEl.innerHTML = '<p class="muted small">No sync conflicts recorded.</p>';
  } else {
    for (const c of state.conflicts) {
      const row = document.createElement('div');
      row.className = 'log-row is-warning';

      const head = document.createElement('div');
      head.className = 'row-between';
      const titleEl = document.createElement('strong');
      titleEl.textContent = `${c.kind} (${c.resolution})`;
      const timeEl = document.createElement('span');
      timeEl.className = 'small muted';
      timeEl.textContent = new Date(c.timestamp).toLocaleString();
      head.append(titleEl, timeEl);

      const targetEl = document.createElement('div');
      targetEl.className = 'small muted';
      targetEl.textContent = c.url || c.folderPath;

      const summaryEl = document.createElement('div');
      summaryEl.className = 'small';
      summaryEl.textContent = `Local: ${c.localSummary} | Remote: ${c.remoteSummary}`;

      row.append(head, targetEl, summaryEl);
      conflictsListEl.append(row);
    }
  }

  historyListEl.innerHTML = '';
  if (state.history.length === 0) {
    historyListEl.innerHTML = '<p class="muted small">No sync runs yet.</p>';
  } else {
    for (const h of state.history) {
      const row = document.createElement('div');
      row.className = `log-row is-${h.status}`;
      const titleRow = document.createElement('div');
      titleRow.className = 'row-between';
      const strong = document.createElement('strong');
      strong.textContent = `${h.profileName} (${h.trigger})`;
      const time = document.createElement('span');
      time.className = 'small muted';
      time.textContent = new Date(h.timestamp).toLocaleString();
      titleRow.append(strong, time);

      const msg = document.createElement('div');
      msg.className = 'small';
      msg.textContent = h.message;
      row.append(titleRow, msg);

      if (h.skipped && h.skipped.length > 0) {
        const list = document.createElement('ul');
        list.className = 'preview-list muted';
        for (const s of h.skipped) {
          const item = document.createElement('li');
          item.textContent = `Skipped (${s.reason}): ${s.title} — ${s.url}`;
          list.append(item);
        }
        row.append(list);
      }

      historyListEl.append(row);
    }
  }
}

function renderPreviewModal(preview: DryRunPreviewPayload): void {
  pendingPreviewProfileId = preview.profileId;
  previewBodyEl.innerHTML = '';

  const intro = document.createElement('p');
  intro.textContent = `Preview for "${preview.profileName}" (${preview.commitSha ? `remote @ ${preview.commitSha.slice(0, 7)}` : 'empty remote branch'}):`;
  previewBodyEl.append(intro);

  const addSection = (heading: string, lines: string[]) => {
    if (lines.length === 0) return;
    const h = document.createElement('h3');
    h.textContent = `${heading} (${lines.length})`;
    const ul = document.createElement('ul');
    ul.className = 'preview-list';
    for (const text of lines.slice(0, 50)) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.append(li);
    }
    if (lines.length > 50) {
      const li = document.createElement('li');
      li.textContent = `…and ${lines.length - 50} more.`;
      ul.append(li);
    }
    previewBodyEl.append(h, ul);
  };

  addSection(
    'Push to Git',
    [
      ...preview.summary.addedBookmarks.map((b) => `+ [${b.folderPath || 'root'}] ${b.title} (${b.url})`),
      ...preview.summary.updatedBookmarks.map((b) => `~ [${b.folderPath || 'root'}] ${b.title}`),
      ...preview.summary.movedBookmarks.map((b) => `-> ${b.title}: ${b.fromPath || 'root'} -> ${b.toPath || 'root'}`),
      ...preview.summary.removedBookmarks.map((b) => `- [${b.folderPath || 'root'}] ${b.title}`),
    ],
  );

  addSection(
    'Pull to Browser Folder',
    [
      ...preview.summary.remoteAddedBookmarks.map((b) => `+ [${b.folderPath || 'root'}] ${b.title} (${b.url})`),
      ...preview.summary.remoteUpdatedBookmarks.map((b) => `~ [${b.folderPath || 'root'}] ${b.title}`),
      ...preview.summary.remoteMovedBookmarks.map((b) => `-> ${b.title}: ${b.fromPath || 'root'} -> ${b.toPath || 'root'}`),
      ...preview.summary.remoteRemovedBookmarks.map((b) => `- [${b.folderPath || 'root'}] ${b.title}`),
    ],
  );

  addSection(
    'Skipped Unsafe URLs',
    preview.skipped.map((s) => `${s.reason}: ${s.title} (${s.url})`),
  );

  addSection(
    'Auto-Resolved Conflicts',
    preview.conflicts.map((c) => `${c.kind} (${c.resolution}): ${c.remoteSummary}`),
  );

  if (!preview.remoteCommitNeeded && !preview.localPatchNeeded && preview.skipped.length === 0) {
    const clean = document.createElement('p');
    clean.className = 'muted';
    clean.textContent = 'Local folder and remote repository are already identical.';
    previewBodyEl.append(clean);
  }

  previewModal.showModal();
}

// Tabs
document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => {
      p.hidden = p.id !== `tab-${target}`;
    });
  });
});

forgeSelect.addEventListener('change', updateForgeUi);

document.getElementById('btn-new-profile')?.addEventListener('click', () => {
  loadProfileIntoForm(null);
  renderState();
});

document.getElementById('btn-refresh-folders')?.addEventListener('click', async () => {
  folders = await sendRpc<SelectableFolderNode[]>({ type: 'LIST_FOLDERS' });
  renderFolderPicker();
});

document.getElementById('btn-test-conn')?.addEventListener('click', async () => {
  connStatusEl.textContent = 'Testing connection…';
  try {
    await ensureOriginPermission(instanceInput.value);
    const info = await sendRpc<{
      fullName: string;
      branchExists: boolean;
      defaultBranch: string;
    }>({
      type: 'TEST_CONNECTION',
      config: {
        forge: forgeSelect.value as ForgeKind,
        instanceUrl: instanceInput.value.trim() || undefined,
        owner: ownerInput.value.trim(),
        repo: repoInput.value.trim(),
        branch: branchInput.value.trim() || 'main',
        token: tokenInput.value.trim(),
      },
    });
    connStatusEl.textContent = info.branchExists
      ? `Connected to ${info.fullName} (branch found).`
      : `Connected to ${info.fullName} (branch will be initialized on first sync).`;
  } catch (err) {
    connStatusEl.textContent = err instanceof Error ? err.message : 'Connection failed.';
  }
});

deviceLoginBtn.addEventListener('click', async () => {
  stopDevicePoll();
  devicePollStatus.textContent = 'Requesting device code…';
  try {
    await ensureOriginPermission(instanceInput.value);
    const codeRes = await sendRpc<GitHubDeviceCodeResponse>({
      type: 'START_GITHUB_DEVICE_FLOW',
      instanceUrl: instanceInput.value.trim() || undefined,
    });
    devicePendingBox.hidden = false;
    deviceCodeEl.textContent = codeRes.user_code;
    deviceVerifyLink.href = codeRes.verification_uri;
    deviceVerifyLink.textContent = codeRes.verification_uri;
    devicePollStatus.textContent = 'Waiting for authorization…';
    window.open(codeRes.verification_uri, '_blank', 'noopener,noreferrer');

    let intervalMs = Math.max(5, codeRes.interval || 5) * 1000;
    const poll = async (): Promise<void> => {
      try {
        const res = await sendRpc<GitHubDeviceTokenPollResult>({
          type: 'POLL_GITHUB_DEVICE_FLOW',
          deviceCode: codeRes.device_code,
          instanceUrl: instanceInput.value.trim() || undefined,
        });
        if (res.status === 'authorized') {
          tokenInput.value = res.accessToken;
          authMethod = 'device-flow';
          devicePollStatus.textContent = 'Authorized! Token populated below (remember to Save Profile).';
          return;
        }
        if (res.status === 'slow_down') {
          intervalMs = Math.max(intervalMs + 5000, res.interval * 1000);
        } else if (res.status !== 'pending') {
          devicePollStatus.textContent = res.message;
          return;
        }
        activePollTimer = window.setTimeout(() => void poll(), intervalMs);
      } catch (err) {
        devicePollStatus.textContent = err instanceof Error ? err.message : 'Polling failed.';
      }
    };
    activePollTimer = window.setTimeout(() => void poll(), intervalMs);
  } catch (err) {
    devicePendingBox.hidden = false;
    devicePollStatus.textContent = err instanceof Error ? err.message : 'Device Flow failed.';
  }
});

document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
  const code = deviceCodeEl.textContent || '';
  if (code) await navigator.clipboard.writeText(code);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  feedbackEl.textContent = 'Saving…';
  try {
    const profile = buildProfileFromForm();
    await ensureOriginPermission(profile.instanceUrl);
    state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_PROFILE', profile });
    editingProfileId = profile.id;
    renderState();
    feedbackEl.textContent = 'Profile saved.';
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Save failed.';
  }
});

deleteBtn.addEventListener('click', async () => {
  if (!editingProfileId) return;
  state = await sendRpc<ExtensionStatePayload>({
    type: 'DELETE_PROFILE',
    profileId: editingProfileId,
  });
  loadProfileIntoForm(state.profiles[0] ?? null);
  renderState();
});

async function saveCurrentAndRunPreview(): Promise<void> {
  const profile = buildProfileFromForm();
  await ensureOriginPermission(profile.instanceUrl);
  state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_PROFILE', profile });
  editingProfileId = profile.id;
  renderState();
  feedbackEl.textContent = 'Computing dry-run preview…';
  const preview = await sendRpc<DryRunPreviewPayload>({
    type: 'RUN_DRY_RUN',
    profileId: profile.id,
  });
  feedbackEl.textContent = '';
  renderPreviewModal(preview);
}

document.getElementById('btn-preview-sync')?.addEventListener('click', () => {
  void saveCurrentAndRunPreview().catch((err) => {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Preview failed.';
  });
});

document.getElementById('btn-sync-profile')?.addEventListener('click', async () => {
  try {
    const profile = buildProfileFromForm();
    await ensureOriginPermission(profile.instanceUrl);
    state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_PROFILE', profile });
    editingProfileId = profile.id;

    const hasSnapshot = Boolean(state.snapshots[profile.id]);
    if (!hasSnapshot && profile.safety.previewFirstSync) {
      await saveCurrentAndRunPreview();
      return;
    }

    feedbackEl.textContent = 'Syncing now…';
    const res = await sendRpc<SyncResult>({
      type: 'RUN_SYNC',
      profileId: profile.id,
      trigger: 'manual',
    });
    state = await sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' });
    renderState();
    feedbackEl.textContent = res.committed
      ? `Synced cleanly (${res.commitSha?.slice(0, 7) ?? ''}).`
      : 'Sync complete.';
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Sync failed.';
  }
});

confirmPreviewBtn.addEventListener('click', async () => {
  if (!pendingPreviewProfileId) return;
  confirmPreviewBtn.disabled = true;
  try {
    const res = await sendRpc<SyncResult>({
      type: 'RUN_SYNC',
      profileId: pendingPreviewProfileId,
      trigger: 'manual',
    });
    previewModal.close();
    state = await sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' });
    renderState();
    feedbackEl.textContent = res.committed
      ? `Initial sync committed (${res.commitSha?.slice(0, 7) ?? ''}).`
      : 'Initial sync complete.';
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Sync failed.';
    previewModal.close();
  } finally {
    confirmPreviewBtn.disabled = false;
  }
});

document.getElementById('btn-close-preview')?.addEventListener('click', () => previewModal.close());
document.getElementById('btn-cancel-preview')?.addEventListener('click', () => previewModal.close());

document.getElementById('btn-clear-logs')?.addEventListener('click', async () => {
  state = await sendRpc<ExtensionStatePayload>({ type: 'CLEAR_HISTORY' });
  renderState();
});

document.getElementById('btn-save-oauth-id')?.addEventListener('click', async () => {
  state = await sendRpc<ExtensionStatePayload>({
    type: 'SAVE_OAUTH_CLIENT_ID',
    clientId: oauthOverrideInput.value.trim(),
  });
  renderState();
  oauthSaveStatusEl.textContent = 'Saved.';
});

async function init(): Promise<void> {
  const [loadedState, loadedFolders] = await Promise.all([
    sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' }),
    sendRpc<SelectableFolderNode[]>({ type: 'LIST_FOLDERS' }),
  ]);
  state = loadedState;
  folders = loadedFolders;
  const active =
    state.profiles.find((p) => p.id === state?.activeProfileId) ??
    state.profiles[0] ??
    null;
  loadProfileIntoForm(active);
  renderState();
}

void init().catch((err) => {
  feedbackEl.textContent = err instanceof Error ? err.message : 'Failed to initialize settings.';
});
