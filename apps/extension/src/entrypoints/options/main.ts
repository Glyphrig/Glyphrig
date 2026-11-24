import {
  DEFAULT_SAFETY_CONFIG,
  generateId,
  type ForgeKind,
  type GitHubDeviceCodeResponse,
  type GitHubDeviceTokenPollResult,
  type ProfileConfig,
  type SharedGitHubAccount,
  type SyncMode,
  type SyncResult,
} from '@glyphrig/core';
import { browser } from 'wxt/browser';
import {
  countProfilesUsingAccount,
  findMatchingSharedAccount,
  normalizeGitHubInstance,
} from '../../lib/accounts.js';
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
const verifiedUsernameEl = document.getElementById('verified-username')!;

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
const githubAccountSelect = document.getElementById('f-github-account') as HTMLSelectElement;
const githubAccountHintEl = document.getElementById('github-account-hint')!;
const patFieldWrap = document.getElementById('pat-field-wrap')!;
const deviceLoginBtn = document.getElementById('btn-device-login') as HTMLButtonElement;
const addGithubAccountBtn = document.getElementById('btn-add-github-account') as HTMLButtonElement;
const removeGithubAccountBtn = document.getElementById('btn-remove-github-account') as HTMLButtonElement;
const devicePendingBox = document.getElementById('device-pending')!;
const deviceCodeEl = document.getElementById('device-user-code')!;
const deviceVerifyLink = document.getElementById('device-verify-link') as HTMLAnchorElement;
const devicePollStatus = document.getElementById('device-poll-status')!;

const deviceFlowModal = document.getElementById('device-flow-modal') as HTMLDialogElement;
const deviceModalCodeEl = document.getElementById('device-modal-code')!;
const deviceCopyFeedbackEl = document.getElementById('device-copy-feedback')!;
const deviceModalOpenLink = document.getElementById('device-modal-open-link') as HTMLAnchorElement;
const deviceModalUrlEl = document.getElementById('device-modal-url')!;
const deviceModalStatusEl = document.getElementById('device-modal-status')!;
const modalCopyCodeBtn = document.getElementById('btn-modal-copy-code') as HTMLButtonElement;
const cancelDeviceModalBtn = document.getElementById('btn-cancel-device-modal') as HTMLButtonElement;
const doneDeviceModalBtn = document.getElementById('btn-done-device-modal') as HTMLButtonElement;
const inlineCopyCodeBtn = document.getElementById('btn-copy-code') as HTMLButtonElement;

const enabledCheck = document.getElementById('f-enabled') as HTMLInputElement;
const syncModeSelect = document.getElementById('f-syncmode') as HTMLSelectElement;
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
let selectedAccountId = '';
let deviceFlowMode: 'update-current' | 'add-new' = 'update-current';
let oauthRefreshToken: string | undefined;
let oauthTokenExpiresAt: string | undefined;
let oauthRefreshTokenExpiresAt: string | undefined;
let oauthClientId: string | undefined;
let verifiedUsername = '';
let pendingPreviewProfileId: string | null = null;
let activePollTimer: number | undefined;

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function setDeviceModalStatus(message: string, tone: 'info' | 'ok' | 'err'): void {
  deviceModalStatusEl.textContent = message;
  deviceModalStatusEl.className = `status-banner is-${tone}`;
}

function renderVerifiedUsername(): void {
  verifiedUsernameEl.textContent = verifiedUsername
    ? `Attribution: @${verifiedUsername}`
    : '';
}

function stopDevicePoll(): void {
  if (activePollTimer !== undefined) {
    window.clearTimeout(activePollTimer);
    activePollTimer = undefined;
  }
}

function renderGitHubAccountSelect(): void {
  const forge = forgeSelect.value as ForgeKind;
  if (forge !== 'github') {
    patFieldWrap.hidden = false;
    tokenInput.required = true;
    return;
  }

  const targetInstance = normalizeGitHubInstance(instanceInput.value);
  const matchingAccounts = (state?.sharedAccounts ?? []).filter(
    (acc) => normalizeGitHubInstance(acc.instanceUrl) === targetInstance,
  );

  if (selectedAccountId && !matchingAccounts.some((a) => a.id === selectedAccountId)) {
    selectedAccountId = '';
  }

  githubAccountSelect.innerHTML = '';
  for (const acc of matchingAccounts) {
    const opt = document.createElement('option');
    opt.value = acc.id;
    const count = countProfilesUsingAccount(state?.profiles ?? [], acc.id);
    const labelName = acc.username ? `@${acc.username}` : 'GitHub Account';
    const hostLabel = targetInstance.replace(/^https?:\/\//, '');
    opt.textContent = `${labelName} · ${hostLabel}${count > 0 ? ` (${count} profile${count === 1 ? '' : 's'})` : ''}`;
    opt.selected = acc.id === selectedAccountId;
    githubAccountSelect.append(opt);
  }

  const patOpt = document.createElement('option');
  patOpt.value = '__pat__';
  patOpt.textContent = 'Profile-specific Personal Access Token (PAT)';
  patOpt.selected = !selectedAccountId;
  githubAccountSelect.append(patOpt);

  githubAccountSelect.value = selectedAccountId || '__pat__';

  const activeAccount = matchingAccounts.find((a) => a.id === selectedAccountId);
  if (activeAccount) {
    patFieldWrap.hidden = true;
    tokenInput.required = false;
    deviceLoginBtn.textContent = 'Re-authorize';
    addGithubAccountBtn.hidden = false;
    removeGithubAccountBtn.hidden = false;
    const count = countProfilesUsingAccount(state?.profiles ?? [], activeAccount.id);
    const refreshStatus = activeAccount.refreshToken
      ? 'Auto-refresh enabled'
      : activeAccount.tokenExpiresAt
        ? `Expires ${new Date(activeAccount.tokenExpiresAt).toLocaleString()}`
        : 'Reusable OAuth token';
    githubAccountHintEl.textContent = `${refreshStatus} · Linked to ${count} profile${count === 1 ? '' : 's'}.`;
    if (activeAccount.username) {
      verifiedUsername = activeAccount.username;
      renderVerifiedUsername();
    }
  } else {
    patFieldWrap.hidden = false;
    tokenInput.required = true;
    deviceLoginBtn.textContent = 'Sign in with GitHub';
    addGithubAccountBtn.hidden = matchingAccounts.length === 0;
    removeGithubAccountBtn.hidden = true;
    githubAccountHintEl.textContent =
      matchingAccounts.length > 0
        ? 'Using a profile-specific PAT, or pick a saved GitHub account above.'
        : 'Sign in with GitHub above or paste a fine-grained PAT below.';
  }
}

function updateForgeUi(): void {
  const forge = forgeSelect.value as ForgeKind;
  instanceInput.placeholder = defaultInstancePlaceholder(forge);
  tokenHintEl.textContent = tokenHintForForge(forge);
  githubDeviceBox.hidden = forge !== 'github';
  renderGitHubAccountSelect();
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
    const defaultGithubAccount = (state?.sharedAccounts ?? []).find(
      (a) => normalizeGitHubInstance(a.instanceUrl) === 'https://github.com',
    );
    selectedAccountId = defaultGithubAccount?.id ?? '';
    tokenInput.value = '';
    authMethod = defaultGithubAccount ? defaultGithubAccount.authMethod : 'pat';
    oauthRefreshToken = undefined;
    oauthTokenExpiresAt = undefined;
    oauthRefreshTokenExpiresAt = undefined;
    oauthClientId = undefined;
    verifiedUsername = defaultGithubAccount?.username ?? '';
    selectedFolderId = '';
    selectedFolderTitle = '';
    enabledCheck.checked = true;
    syncModeSelect.value = 'two-way';
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
    selectedAccountId = profile.forge === 'github' ? (profile.accountId ?? '') : '';
    const linkedAcc = selectedAccountId
      ? (state?.sharedAccounts ?? []).find((a) => a.id === selectedAccountId)
      : undefined;
    tokenInput.value = selectedAccountId ? '' : profile.token;
    authMethod = linkedAcc?.authMethod ?? profile.authMethod ?? 'pat';
    oauthRefreshToken = selectedAccountId ? undefined : profile.refreshToken;
    oauthTokenExpiresAt = selectedAccountId ? undefined : profile.tokenExpiresAt;
    oauthRefreshTokenExpiresAt = selectedAccountId ? undefined : profile.refreshTokenExpiresAt;
    oauthClientId = selectedAccountId ? undefined : profile.oauthClientId;
    verifiedUsername = linkedAcc?.username || profile.username || '';
    selectedFolderId = profile.rootFolderId;
    selectedFolderTitle = profile.rootFolderTitle ?? '';
    enabledCheck.checked = profile.enabled;
    syncModeSelect.value = profile.syncMode ?? 'two-way';
    autoSyncCheck.checked = profile.autoSync;
    debounceInput.value = String(profile.pushDebounceSeconds || 60);
    pullMinInput.value = String(profile.pullIntervalMinutes || 15);
    safetyPrivateCheck.checked = profile.safety.filterPrivateUrls;
    safetyCredsCheck.checked = profile.safety.filterCredentials;
    safetyTrackingCheck.checked = profile.safety.stripTrackingParams;
    safetyPreviewCheck.checked = profile.safety.previewFirstSync;
  }
  renderVerifiedUsername();
  updateForgeUi();
  renderFolderPicker();
}

function buildProfileFromForm(): ProfileConfig {
  if (!selectedFolderId) {
    throw new Error('Please choose a bookmark folder to sync.');
  }
  const forge = forgeSelect.value as ForgeKind;
  const usingSharedAccount = forge === 'github' && Boolean(selectedAccountId);
  const linkedAccount = usingSharedAccount
    ? (state?.sharedAccounts ?? []).find((a) => a.id === selectedAccountId)
    : undefined;

  if (!usingSharedAccount && !tokenInput.value.trim()) {
    throw new Error('Please provide a Personal Access Token or sign in with GitHub.');
  }

  return {
    id: editingProfileId ?? generateId(),
    name: nameInput.value.trim() || 'Bookmarks',
    enabled: enabledCheck.checked,
    syncMode: (syncModeSelect.value as SyncMode) || 'two-way',
    forge,
    ...(instanceInput.value.trim() ? { instanceUrl: instanceInput.value.trim() } : {}),
    owner: ownerInput.value.trim(),
    repo: repoInput.value.trim(),
    branch: branchInput.value.trim() || 'main',
    rootDir: rootDirInput.value.trim() || 'bookmarks',
    ...(usingSharedAccount ? { accountId: selectedAccountId } : {}),
    token: usingSharedAccount ? '' : tokenInput.value.trim(),
    authMethod: usingSharedAccount ? (linkedAccount?.authMethod ?? 'device-flow') : authMethod,
    ...(!usingSharedAccount && oauthRefreshToken ? { refreshToken: oauthRefreshToken } : {}),
    ...(!usingSharedAccount && oauthTokenExpiresAt ? { tokenExpiresAt: oauthTokenExpiresAt } : {}),
    ...(!usingSharedAccount && oauthRefreshTokenExpiresAt
      ? { refreshTokenExpiresAt: oauthRefreshTokenExpiresAt }
      : {}),
    ...(!usingSharedAccount && oauthClientId ? { oauthClientId } : {}),
    ...(verifiedUsername ? { username: verifiedUsername } : {}),
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

  const archivedKeys = new Set(
    preview.summary.archivedBookmarks.map((b) => `${b.folderPath}\0${b.url}`),
  );
  const nonArchivedRemoved = preview.summary.removedBookmarks.filter(
    (b) => !archivedKeys.has(`${b.folderPath}\0${b.url}`),
  );

  addSection(
    'Push to Git',
    [
      ...preview.summary.addedBookmarks.map((b) => `+ [${b.folderPath || 'root'}] ${b.title} (${b.url})`),
      ...preview.summary.updatedBookmarks.map((b) => `~ [${b.folderPath || 'root'}] ${b.title}`),
      ...preview.summary.movedBookmarks.map((b) => `-> ${b.title}: ${b.fromPath || 'root'} -> ${b.toPath || 'root'}`),
      ...nonArchivedRemoved.map((b) => `- [${b.folderPath || 'root'}] ${b.title}`),
    ],
  );

  addSection(
    'Archive to .archived/',
    preview.summary.archivedBookmarks.map(
      (b) => `archive [${b.folderPath || 'root'}] ${b.title} (${b.url})`,
    ),
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

const clearVerifiedUsername = (): void => {
  if (!verifiedUsername) return;
  verifiedUsername = '';
  renderVerifiedUsername();
};

forgeSelect.addEventListener('change', () => {
  updateForgeUi();
  clearVerifiedUsername();
});
instanceInput.addEventListener('input', () => {
  renderGitHubAccountSelect();
  clearVerifiedUsername();
});
githubAccountSelect.addEventListener('change', () => {
  selectedAccountId = githubAccountSelect.value === '__pat__' ? '' : githubAccountSelect.value;
  if (selectedAccountId) {
    const acc = (state?.sharedAccounts ?? []).find((a) => a.id === selectedAccountId);
    authMethod = acc?.authMethod ?? 'device-flow';
    verifiedUsername = acc?.username ?? '';
    renderVerifiedUsername();
  } else {
    authMethod = 'pat';
    clearVerifiedUsername();
  }
  renderGitHubAccountSelect();
});
tokenInput.addEventListener('input', () => {
  selectedAccountId = '';
  authMethod = 'pat';
  oauthRefreshToken = undefined;
  oauthTokenExpiresAt = undefined;
  oauthRefreshTokenExpiresAt = undefined;
  oauthClientId = undefined;
  clearVerifiedUsername();
  renderGitHubAccountSelect();
});

document.getElementById('btn-new-profile')?.addEventListener('click', () => {
  loadProfileIntoForm(null);
  renderState();
  nameInput.focus();
  nameInput.select();
  feedbackEl.textContent = 'Creating a new profile — fill in the fields, select a folder, and click Save Profile.';
});

const backupStatusEl = document.getElementById('backup-status')!;

document.getElementById('btn-sync-all-profiles')?.addEventListener('click', async () => {
  backupStatusEl.textContent = 'Syncing all enabled profiles…';
  try {
    const res = await sendRpc<{
      synced: number;
      failed: Array<{ profileId: string; name: string; error: string }>;
    }>({ type: 'RUN_SYNC_ALL' });
    state = await sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' });
    renderState();
    backupStatusEl.textContent =
      res.failed.length > 0
        ? `Synced ${res.synced}; ${res.failed.length} failed (${res.failed.map((f) => `${f.name}: ${f.error}`).join('; ')}).`
        : `Synced all ${res.synced} enabled profile(s).`;
  } catch (err) {
    backupStatusEl.textContent = err instanceof Error ? err.message : 'Sync all failed.';
  }
});
const importConfigInput = document.getElementById('input-import-config') as HTMLInputElement;

document.getElementById('btn-export-config')?.addEventListener('click', () => {
  if (!state) return;
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    sharedAccounts: state.sharedAccounts,
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    githubOAuthClientIdOverride: state.githubOAuthClientIdOverride,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `glyphrig-config-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  backupStatusEl.textContent = `Exported ${state.profiles.length} profile(s) and ${state.sharedAccounts.length} GitHub account(s).`;
});

document.getElementById('btn-import-config')?.addEventListener('click', () => {
  importConfigInput.value = '';
  importConfigInput.click();
});

importConfigInput.addEventListener('change', async () => {
  const file = importConfigInput.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as {
      sharedAccounts?: SharedGitHubAccount[];
      profiles?: ProfileConfig[];
      activeProfileId?: string | null;
      githubOAuthClientIdOverride?: string;
    };
    if (!Array.isArray(parsed.profiles)) {
      throw new Error('Invalid backup file: missing profiles array.');
    }
    if (Array.isArray(parsed.sharedAccounts)) {
      for (const account of parsed.sharedAccounts) {
        await ensureOriginPermission(account.instanceUrl);
        state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_SHARED_ACCOUNT', account });
      }
    }
    for (const profile of parsed.profiles) {
      await ensureOriginPermission(profile.instanceUrl);
      state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_PROFILE', profile });
    }
    if (parsed.activeProfileId) {
      state = await sendRpc<ExtensionStatePayload>({
        type: 'SET_ACTIVE_PROFILE',
        profileId: parsed.activeProfileId,
      });
    }
    if (typeof parsed.githubOAuthClientIdOverride === 'string') {
      state = await sendRpc<ExtensionStatePayload>({
        type: 'SAVE_OAUTH_CLIENT_ID',
        clientId: parsed.githubOAuthClientIdOverride,
      });
    }
    loadProfileIntoForm(state?.profiles[0] ?? null);
    renderState();
    backupStatusEl.textContent = `Imported ${parsed.profiles.length} profile(s).`;
  } catch (err) {
    backupStatusEl.textContent = err instanceof Error ? err.message : 'Import failed.';
  }
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
      username?: string;
    }>({
      type: 'TEST_CONNECTION',
      config: {
        ...(editingProfileId ? { profileId: editingProfileId } : {}),
        ...(forgeSelect.value === 'github' && selectedAccountId
          ? { accountId: selectedAccountId }
          : {}),
        forge: forgeSelect.value as ForgeKind,
        instanceUrl: instanceInput.value.trim() || undefined,
        owner: ownerInput.value.trim(),
        repo: repoInput.value.trim(),
        branch: branchInput.value.trim() || 'main',
        token: forgeSelect.value === 'github' && selectedAccountId ? '' : tokenInput.value.trim(),
      },
    });
    verifiedUsername = info.username ?? '';
    renderVerifiedUsername();
    const userNote = info.username ? ` (as @${info.username})` : '';
    connStatusEl.textContent = info.branchExists
      ? `Connected to ${info.fullName}${userNote} (branch found).`
      : `Connected to ${info.fullName}${userNote} (branch will be initialized on first sync).`;
  } catch (err) {
    connStatusEl.textContent = err instanceof Error ? err.message : 'Connection failed.';
  }
});

async function startDeviceFlow(mode: 'update-current' | 'add-new'): Promise<void> {
  deviceFlowMode = mode;
  stopDevicePoll();
  deviceLoginBtn.disabled = true;
  addGithubAccountBtn.disabled = true;
  devicePollStatus.textContent = 'Requesting device code…';
  try {
    await ensureOriginPermission(instanceInput.value);
    const instanceHost = instanceInput.value.trim() || undefined;
    const normalizedHost = normalizeGitHubInstance(instanceHost);
    const codeRes = await sendRpc<GitHubDeviceCodeResponse>({
      type: 'START_GITHUB_DEVICE_FLOW',
      instanceUrl: instanceHost,
    });

    devicePendingBox.hidden = false;
    deviceCodeEl.textContent = codeRes.user_code;
    deviceVerifyLink.href = codeRes.verification_uri;
    deviceVerifyLink.textContent = codeRes.verification_uri;
    devicePollStatus.textContent = 'Waiting for authorization on GitHub…';

    deviceModalCodeEl.textContent = codeRes.user_code;
    deviceModalOpenLink.href = codeRes.verification_uri;
    deviceModalUrlEl.textContent = codeRes.verification_uri;
    cancelDeviceModalBtn.hidden = false;
    doneDeviceModalBtn.hidden = true;
    setDeviceModalStatus(
      `Copy the code above, then open GitHub to authorize (expires in ${Math.max(1, Math.round(codeRes.expires_in / 60))} min).`,
      'info',
    );
    if (!deviceFlowModal.open) {
      deviceFlowModal.showModal();
    }

    const copied = await copyTextToClipboard(codeRes.user_code);
    deviceCopyFeedbackEl.textContent = copied
      ? '✓ Code copied to clipboard — ready to paste on GitHub.'
      : 'Click Copy Code above before opening GitHub.';

    let intervalMs = Math.max(5, codeRes.interval || 5) * 1000;
    const poll = async (): Promise<void> => {
      try {
        const res = await sendRpc<GitHubDeviceTokenPollResult>({
          type: 'POLL_GITHUB_DEVICE_FLOW',
          deviceCode: codeRes.device_code,
          instanceUrl: instanceHost,
        });
        if (res.status === 'authorized') {
          let ghUser: { username?: string; displayName?: string } = {};
          try {
            ghUser = await sendRpc<{ username?: string; displayName?: string }>({
              type: 'FETCH_GITHUB_USER',
              token: res.accessToken,
              instanceUrl: instanceHost,
            });
          } catch {
            // Best-effort lookup; proceed with saving account
          }

          const existingMatch =
            deviceFlowMode === 'update-current' && selectedAccountId
              ? state?.sharedAccounts.find((a) => a.id === selectedAccountId)
              : findMatchingSharedAccount(state?.sharedAccounts ?? [], {
                  instanceUrl: normalizedHost,
                  username: ghUser.username,
                });

          const tokenExpiresAt = res.expiresIn
            ? new Date(Date.now() + res.expiresIn * 1000).toISOString()
            : undefined;
          const refreshTokenExpiresAt = res.refreshTokenExpiresIn
            ? new Date(Date.now() + res.refreshTokenExpiresIn * 1000).toISOString()
            : undefined;
          const clientId = state?.effectiveGithubOAuthClientId || undefined;

          const account: SharedGitHubAccount = {
            id: existingMatch?.id ?? generateId(),
            instanceUrl: normalizedHost,
            ...(ghUser.username
              ? { username: ghUser.username }
              : existingMatch?.username
                ? { username: existingMatch.username }
                : {}),
            ...(ghUser.displayName
              ? { displayName: ghUser.displayName }
              : existingMatch?.displayName
                ? { displayName: existingMatch.displayName }
                : {}),
            token: res.accessToken,
            authMethod: 'device-flow',
            ...(res.refreshToken ? { refreshToken: res.refreshToken } : {}),
            ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
            ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
            ...(clientId ? { oauthClientId: clientId } : {}),
            updatedAt: new Date().toISOString(),
          };

          state = await sendRpc<ExtensionStatePayload>({
            type: 'SAVE_SHARED_ACCOUNT',
            account,
          });
          selectedAccountId = account.id;
          authMethod = 'device-flow';
          tokenInput.value = '';
          oauthRefreshToken = undefined;
          oauthTokenExpiresAt = undefined;
          oauthRefreshTokenExpiresAt = undefined;
          oauthClientId = undefined;
          verifiedUsername = account.username ?? '';
          renderVerifiedUsername();

          const lifetimeNote = res.refreshToken
            ? 'Auto-refresh enabled (6-month rolling session).'
            : res.expiresIn
              ? `Note: GitHub issued an expiring token (~${Math.max(1, Math.round(res.expiresIn / 3600))}h) without a refresh token.`
              : 'Non-expiring GitHub OAuth token.';

          let savedNote = 'Account ready — select your repo & folder, then click Save Profile.';
          if (selectedFolderId && ownerInput.value.trim() && repoInput.value.trim()) {
            try {
              const profile = buildProfileFromForm();
              state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_PROFILE', profile });
              editingProfileId = profile.id;
              savedNote = 'Linked & saved automatically to your profile.';
            } catch (saveErr) {
              savedNote =
                saveErr instanceof Error
                  ? `Click Save Profile (${saveErr.message}).`
                  : 'Click Save Profile to persist.';
            }
          }

          renderGitHubAccountSelect();
          renderState();

          const linkedCount = countProfilesUsingAccount(state?.profiles ?? [], account.id);
          const who = account.username ? `@${account.username}` : 'GitHub account';
          const reuseNote =
            linkedCount > 1 ? ` Shared across ${linkedCount} profiles.` : '';
          const successMsg = `✓ Authorized ${who}! ${savedNote}${reuseNote} ${lifetimeNote}`;
          devicePollStatus.textContent = successMsg;
          setDeviceModalStatus(successMsg, 'ok');
          cancelDeviceModalBtn.hidden = true;
          doneDeviceModalBtn.hidden = false;
          return;
        }
        if (res.status === 'slow_down') {
          intervalMs = Math.max(intervalMs + 5000, res.interval * 1000);
        } else if (res.status !== 'pending') {
          devicePollStatus.textContent = res.message;
          setDeviceModalStatus(res.message, 'err');
          return;
        }
        activePollTimer = window.setTimeout(() => void poll(), intervalMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Polling failed.';
        devicePollStatus.textContent = msg;
        setDeviceModalStatus(msg, 'err');
      }
    };
    activePollTimer = window.setTimeout(() => void poll(), intervalMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Device Flow failed.';
    devicePendingBox.hidden = false;
    devicePollStatus.textContent = msg;
    setDeviceModalStatus(msg, 'err');
  } finally {
    deviceLoginBtn.disabled = false;
    addGithubAccountBtn.disabled = false;
  }
}

deviceLoginBtn.addEventListener('click', () => {
  void startDeviceFlow(selectedAccountId ? 'update-current' : 'add-new');
});

addGithubAccountBtn?.addEventListener('click', () => {
  void startDeviceFlow('add-new');
});

removeGithubAccountBtn?.addEventListener('click', async () => {
  if (!selectedAccountId) return;
  const count = countProfilesUsingAccount(state?.profiles ?? [], selectedAccountId);
  const confirmMsg =
    count > 0
      ? `Remove this shared GitHub account? ${count} profile(s) currently use it.`
      : 'Remove this shared GitHub account?';
  if (!window.confirm(confirmMsg)) return;

  state = await sendRpc<ExtensionStatePayload>({
    type: 'DELETE_SHARED_ACCOUNT',
    accountId: selectedAccountId,
  });
  selectedAccountId = '';
  renderGitHubAccountSelect();
  renderState();
});

modalCopyCodeBtn?.addEventListener('click', async () => {
  const code = deviceModalCodeEl.textContent?.trim() || '';
  if (await copyTextToClipboard(code)) {
    deviceCopyFeedbackEl.textContent = '✓ Copied to clipboard.';
    const prev = modalCopyCodeBtn.textContent;
    modalCopyCodeBtn.textContent = 'Copied!';
    window.setTimeout(() => {
      modalCopyCodeBtn.textContent = prev || 'Copy Code';
    }, 1500);
  } else {
    deviceCopyFeedbackEl.textContent = 'Unable to write to clipboard automatically — please copy the code manually.';
  }
});

inlineCopyCodeBtn?.addEventListener('click', async () => {
  const code = deviceCodeEl.textContent?.trim() || '';
  if (await copyTextToClipboard(code)) {
    const prev = inlineCopyCodeBtn.textContent;
    inlineCopyCodeBtn.textContent = 'Copied!';
    window.setTimeout(() => {
      inlineCopyCodeBtn.textContent = prev || 'Copy Code';
    }, 1500);
  }
});

document.getElementById('btn-open-device-modal')?.addEventListener('click', () => {
  if (!deviceFlowModal.open) deviceFlowModal.showModal();
});

document.getElementById('btn-close-device-modal')?.addEventListener('click', () => {
  deviceFlowModal.close();
});

doneDeviceModalBtn?.addEventListener('click', () => {
  deviceFlowModal.close();
});

cancelDeviceModalBtn?.addEventListener('click', () => {
  stopDevicePoll();
  devicePendingBox.hidden = true;
  deviceFlowModal.close();
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
