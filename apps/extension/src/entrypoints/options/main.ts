import {
  DEFAULT_SAFETY_CONFIG,
  decodeGlyphrigInvite,
  generateId,
  isSafeHttpUrl,
  type ForgeKind,
  type GitHubDeviceCodeResponse,
  type GitHubDeviceTokenPollResult,
  type GlyphrigGardenManifest,
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
  if (!isSafeHttpUrl(clean)) {
    throw new Error('URL must start with http:// or https://.');
  }
  const u = new URL(clean);
  const originPattern = `${u.origin}/*`;
  const builtInOrigins = [
    'https://api.github.com/*',
    'https://github.com/*',
    'https://gitlab.com/*',
    'https://codeberg.org/*',
  ];
  if (builtInOrigins.includes(originPattern)) return;
  if (!browser.permissions?.request) return;

  // Call permissions.request directly inside the user gesture (without awaiting
  // permissions.contains first, which loses the transient user activation in Firefox).
  let granted = true;
  try {
    granted = await browser.permissions.request({ origins: [originPattern] });
  } catch {
    return;
  }
  if (!granted) {
    throw new Error(`Host permission for ${u.origin} was denied.`);
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
const liveBadgeCheck = document.getElementById('opt-live-badge') as HTMLInputElement;
const liveBadgeStatusEl = document.getElementById('live-badge-status')!;

const joinGardenInput = document.getElementById('input-join-garden') as HTMLInputElement;
const joinGardenBtn = document.getElementById('btn-join-garden') as HTMLButtonElement;
const joinGardenStatusEl = document.getElementById('join-garden-status')!;

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
let devicePollGeneration = 0;

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
  devicePollGeneration++;
  if (activePollTimer !== undefined) {
    window.clearTimeout(activePollTimer);
    activePollTimer = undefined;
  }
}

function renderGitHubAccountSelect(): void {
  const forge = forgeSelect.value as ForgeKind;
  const isSubscribeOnly = syncModeSelect.value === 'subscribe-only';
  if (forge !== 'github') {
    patFieldWrap.hidden = false;
    tokenInput.required = !isSubscribeOnly;
    if (isSubscribeOnly) {
      tokenHintEl.textContent =
        'Optional for public repos in Subscribe-only mode — leave blank for anonymous read-only sync.';
    }
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
  patOpt.textContent = isSubscribeOnly
    ? 'Anonymous (Public Repo) or Optional PAT'
    : 'Profile-specific Personal Access Token (PAT)';
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
    tokenInput.required = !isSubscribeOnly;
    deviceLoginBtn.textContent = 'Sign in with GitHub';
    addGithubAccountBtn.hidden = matchingAccounts.length === 0;
    removeGithubAccountBtn.hidden = true;
    if (isSubscribeOnly) {
      tokenHintEl.textContent =
        'Optional for public repos in Subscribe-only mode — leave blank for anonymous read-only sync.';
    }
    githubAccountHintEl.textContent = isSubscribeOnly
      ? 'Subscribe-only works without signing in for public repositories (or select an account for private repos).'
      : matchingAccounts.length > 0
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
  const owner = ownerInput.value.trim();
  const repo = repoInput.value.trim();
  if (!owner || !repo) {
    throw new Error('Please enter both Repository Owner and Repository Name.');
  }
  const instanceUrl = instanceInput.value.trim();
  if (instanceUrl && !isSafeHttpUrl(instanceUrl)) {
    throw new Error('Custom instance URL must start with http:// or https://.');
  }
  const siteUrl = siteUrlInput.value.trim();
  if (siteUrl && !isSafeHttpUrl(siteUrl)) {
    throw new Error('Published Site URL must start with http:// or https://.');
  }

  const forge = forgeSelect.value as ForgeKind;
  const syncMode = (syncModeSelect.value as SyncMode) || 'two-way';
  const usingSharedAccount = forge === 'github' && Boolean(selectedAccountId);
  const linkedAccount = usingSharedAccount
    ? (state?.sharedAccounts ?? []).find((a) => a.id === selectedAccountId)
    : undefined;

  if (usingSharedAccount && !linkedAccount) {
    throw new Error(
      'Selected GitHub account is no longer available. Choose another account or sign in again.',
    );
  }
  if (syncMode !== 'subscribe-only' && !usingSharedAccount && !tokenInput.value.trim()) {
    throw new Error('Please provide a Personal Access Token or sign in with GitHub.');
  }

  return {
    id: editingProfileId ?? generateId(),
    name: nameInput.value.trim() || 'Bookmarks',
    enabled: enabledCheck.checked,
    syncMode,
    forge,
    ...(instanceUrl ? { instanceUrl } : {}),
    owner,
    repo,
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
    ...(siteUrl ? { siteUrl } : {}),
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
  liveBadgeCheck.checked = Boolean(state.livePageBadgeEnabled);

  conflictsListEl.innerHTML = '';
  if (state.conflicts.length === 0) {
    conflictsListEl.innerHTML = '<p class="muted small">No sync conflicts recorded.</p>';
  } else {
    for (const c of state.conflicts) {
      const row = document.createElement('div');
      row.className = `log-row ${c.resolved ? 'is-ok' : 'is-warning'}`;

      const head = document.createElement('div');
      head.className = 'row-between';
      const titleEl = document.createElement('strong');
      titleEl.textContent = c.resolved
        ? `${c.kind} — Resolved (${c.resolvedChoice ?? c.resolution})`
        : `${c.kind} (${c.resolution})`;
      const timeEl = document.createElement('span');
      timeEl.className = 'small muted';
      timeEl.textContent = new Date(c.timestamp).toLocaleString();
      head.append(titleEl, timeEl);

      const targetEl = document.createElement('div');
      targetEl.className = 'small muted';
      targetEl.textContent = c.url || c.folderPath;

      const compare = document.createElement('div');
      compare.className = 'conflict-compare';
      const localBox = document.createElement('div');
      localBox.className = 'conflict-side';
      localBox.innerHTML = `<span class="small muted">Local:</span> <span class="small"></span>`;
      localBox.lastElementChild!.textContent = c.localSummary;
      const remoteBox = document.createElement('div');
      remoteBox.className = 'conflict-side';
      remoteBox.innerHTML = `<span class="small muted">Remote:</span> <span class="small"></span>`;
      remoteBox.lastElementChild!.textContent = c.remoteSummary;
      compare.append(localBox, remoteBox);

      row.append(head, targetEl, compare);

      if (!c.resolved) {
        const actions = document.createElement('div');
        actions.className = 'row-gap wrap conflict-actions';
        const errSpan = document.createElement('span');
        errSpan.className = 'small muted';
        const supportsMerge =
          c.kind === 'title-conflict' || c.kind === 'move-conflict';
        const choices: Array<{
          label: string;
          choice: 'local' | 'remote' | 'merged' | 'dismissed';
        }> = [
          { label: 'Keep Mine', choice: 'local' },
          { label: 'Keep Theirs', choice: 'remote' },
          ...(supportsMerge
            ? [{ label: 'Merge Both', choice: 'merged' as const }]
            : []),
          { label: 'Dismiss', choice: 'dismissed' },
        ];
        const rowBtns: HTMLButtonElement[] = [];
        for (const item of choices) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-secondary btn-sm';
          btn.textContent = item.label;
          rowBtns.push(btn);
          btn.addEventListener('click', async () => {
            for (const b of rowBtns) b.disabled = true;
            errSpan.textContent = 'Applying…';
            try {
              state = await sendRpc<ExtensionStatePayload>({
                type: 'RESOLVE_CONFLICT',
                conflictId: c.id,
                choice: item.choice,
              });
              renderState();
            } catch (err) {
              errSpan.textContent =
                err instanceof Error ? err.message : 'Failed to resolve conflict.';
              for (const b of rowBtns) b.disabled = false;
            }
          });
          actions.append(btn);
        }
        actions.append(errSpan);
        row.append(actions);
      }

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
      if (h.pullRequestUrl && isSafeHttpUrl(h.pullRequestUrl)) {
        const prLink = document.createElement('a');
        prLink.href = h.pullRequestUrl;
        prLink.target = '_blank';
        prLink.rel = 'noopener noreferrer';
        prLink.textContent = ` (Open PR${h.pullRequestNumber ? ` #${h.pullRequestNumber}` : ''})`;
        msg.append(prLink);
      }
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
syncModeSelect.addEventListener('change', () => {
  updateForgeUi();
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
    livePageBadgeEnabled: state.livePageBadgeEnabled,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `glyphrig-config-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      sharedAccounts?: unknown[];
      profiles?: unknown[];
      activeProfileId?: string | null;
      githubOAuthClientIdOverride?: string;
      livePageBadgeEnabled?: boolean;
    };
    if (!Array.isArray(parsed.profiles)) {
      throw new Error('Invalid backup file: missing profiles array.');
    }

    // Refresh current browser folders so we never silently bind a stale rootFolderId
    // from a different browser/profile to the wrong local bookmark folder.
    folders = await sendRpc<SelectableFolderNode[]>({ type: 'LIST_FOLDERS' });

    const validForges = new Set<ForgeKind>(['github', 'gitlab', 'forgejo']);
    const validSyncModes = new Set<SyncMode>([
      'two-way',
      'contribute-only',
      'subscribe-only',
      'propose-pr',
    ]);

    let importedAccounts = 0;
    if (Array.isArray(parsed.sharedAccounts)) {
      for (const rawAccount of parsed.sharedAccounts) {
        if (!rawAccount || typeof rawAccount !== 'object') continue;
        const acc = rawAccount as Partial<SharedGitHubAccount>;
        if (!acc.id || !acc.token) continue;
        const normalizedAccount: SharedGitHubAccount = {
          id: String(acc.id),
          instanceUrl: normalizeGitHubInstance(acc.instanceUrl),
          ...(acc.username ? { username: String(acc.username) } : {}),
          ...(acc.displayName ? { displayName: String(acc.displayName) } : {}),
          token: String(acc.token),
          authMethod: acc.authMethod === 'pat' ? 'pat' : 'device-flow',
          ...(acc.refreshToken ? { refreshToken: String(acc.refreshToken) } : {}),
          ...(acc.tokenExpiresAt ? { tokenExpiresAt: String(acc.tokenExpiresAt) } : {}),
          ...(acc.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: String(acc.refreshTokenExpiresAt) }
            : {}),
          ...(acc.oauthClientId ? { oauthClientId: String(acc.oauthClientId) } : {}),
          updatedAt: acc.updatedAt ? String(acc.updatedAt) : new Date().toISOString(),
        };
        await ensureOriginPermission(normalizedAccount.instanceUrl).catch(() => {});
        state = await sendRpc<ExtensionStatePayload>({
          type: 'SAVE_SHARED_ACCOUNT',
          account: normalizedAccount,
        });
        importedAccounts++;
      }
    }

    let importedProfiles = 0;
    let rebindCount = 0;
    for (const rawProfile of parsed.profiles) {
      if (!rawProfile || typeof rawProfile !== 'object') continue;
      const p = rawProfile as Partial<ProfileConfig>;
      if (!p.owner || !p.repo || !p.forge || !validForges.has(p.forge)) {
        continue;
      }

      const matchedFolder = p.rootFolderId
        ? folders.find(
            (f) =>
              f.selectable &&
              f.id === p.rootFolderId &&
              (!p.rootFolderTitle || f.title === p.rootFolderTitle),
          )
        : undefined;
      const needsRebind = !matchedFolder;
      if (needsRebind) {
        rebindCount++;
      }

      const normalizedProfile: ProfileConfig = {
        id: typeof p.id === 'string' && p.id.trim() ? p.id.trim() : generateId(),
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `${p.owner}/${p.repo}`,
        enabled: needsRebind ? false : Boolean(p.enabled ?? true),
        syncMode: p.syncMode && validSyncModes.has(p.syncMode) ? p.syncMode : 'two-way',
        forge: p.forge,
        ...(p.instanceUrl && isSafeHttpUrl(p.instanceUrl)
          ? { instanceUrl: p.instanceUrl.trim() }
          : {}),
        owner: String(p.owner).trim(),
        repo: String(p.repo).trim(),
        branch: typeof p.branch === 'string' && p.branch.trim() ? p.branch.trim() : 'main',
        rootDir: typeof p.rootDir === 'string' && p.rootDir.trim() ? p.rootDir.trim() : 'bookmarks',
        ...(p.accountId ? { accountId: String(p.accountId) } : {}),
        token: typeof p.token === 'string' ? p.token : '',
        authMethod: p.authMethod === 'device-flow' ? 'device-flow' : 'pat',
        ...(p.refreshToken ? { refreshToken: String(p.refreshToken) } : {}),
        ...(p.tokenExpiresAt ? { tokenExpiresAt: String(p.tokenExpiresAt) } : {}),
        ...(p.refreshTokenExpiresAt
          ? { refreshTokenExpiresAt: String(p.refreshTokenExpiresAt) }
          : {}),
        ...(p.oauthClientId ? { oauthClientId: String(p.oauthClientId) } : {}),
        ...(p.username ? { username: String(p.username) } : {}),
        rootFolderId: matchedFolder ? matchedFolder.id : '',
        ...(matchedFolder
          ? { rootFolderTitle: matchedFolder.title }
          : p.rootFolderTitle
            ? { rootFolderTitle: String(p.rootFolderTitle) }
            : {}),
        ...(p.siteUrl && isSafeHttpUrl(p.siteUrl) ? { siteUrl: p.siteUrl.trim() } : {}),
        autoSync: Boolean(p.autoSync ?? true),
        pushDebounceSeconds: Math.max(30, Number(p.pushDebounceSeconds) || 60),
        pullIntervalMinutes: Math.max(1, Number(p.pullIntervalMinutes) || 15),
        safety: {
          ...DEFAULT_SAFETY_CONFIG,
          ...(p.safety && typeof p.safety === 'object' ? p.safety : {}),
        },
      };

      await ensureOriginPermission(normalizedProfile.instanceUrl).catch(() => {});
      state = await sendRpc<ExtensionStatePayload>({
        type: 'SAVE_PROFILE',
        profile: normalizedProfile,
      });
      importedProfiles++;
    }

    if (
      parsed.activeProfileId &&
      state?.profiles.some((p) => p.id === parsed.activeProfileId)
    ) {
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
    if (typeof parsed.livePageBadgeEnabled === 'boolean') {
      const canEnable =
        !parsed.livePageBadgeEnabled ||
        (await browser.permissions?.contains({ permissions: ['tabs'] }).catch(() => false));
      if (canEnable) {
        state = await sendRpc<ExtensionStatePayload>({
          type: 'SET_LIVE_PAGE_BADGE',
          enabled: parsed.livePageBadgeEnabled,
        });
      }
    }

    loadProfileIntoForm(state?.profiles[0] ?? null);
    renderState();
    backupStatusEl.textContent =
      rebindCount > 0
        ? `Imported ${importedProfiles} profile(s) and ${importedAccounts} account(s). ${rebindCount} profile(s) were paused because their browser folder ID was not found — re-select their local folder and re-enable.`
        : `Imported ${importedProfiles} profile(s) and ${importedAccounts} account(s).`;
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
  const myGen = devicePollGeneration;
  deviceLoginBtn.disabled = true;
  addGithubAccountBtn.disabled = true;
  devicePollStatus.textContent = 'Requesting device code…';
  try {
    await ensureOriginPermission(instanceInput.value);
    if (myGen !== devicePollGeneration) return;
    const instanceHost = instanceInput.value.trim() || undefined;
    const normalizedHost = normalizeGitHubInstance(instanceHost);
    const codeRes = await sendRpc<GitHubDeviceCodeResponse>({
      type: 'START_GITHUB_DEVICE_FLOW',
      instanceUrl: instanceHost,
    });
    if (myGen !== devicePollGeneration) return;

    if (!isSafeHttpUrl(codeRes.verification_uri)) {
      throw new Error('GitHub returned an unsafe verification URL.');
    }

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
    if (myGen !== devicePollGeneration) return;
    deviceCopyFeedbackEl.textContent = copied
      ? '✓ Code copied to clipboard — ready to paste on GitHub.'
      : 'Click Copy Code above before opening GitHub.';

    let intervalMs = Math.max(5, codeRes.interval || 5) * 1000;
    const poll = async (): Promise<void> => {
      if (myGen !== devicePollGeneration) return;
      try {
        const res = await sendRpc<GitHubDeviceTokenPollResult>({
          type: 'POLL_GITHUB_DEVICE_FLOW',
          deviceCode: codeRes.device_code,
          instanceUrl: instanceHost,
        });
        if (myGen !== devicePollGeneration) return;
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
          if (myGen !== devicePollGeneration) return;

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
        if (myGen !== devicePollGeneration) return;
        activePollTimer = window.setTimeout(() => void poll(), intervalMs);
      } catch (err) {
        if (myGen !== devicePollGeneration) return;
        const msg = err instanceof Error ? err.message : 'Polling failed.';
        devicePollStatus.textContent = msg;
        setDeviceModalStatus(msg, 'err');
      }
    };
    activePollTimer = window.setTimeout(() => void poll(), intervalMs);
  } catch (err) {
    if (myGen !== devicePollGeneration) return;
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

function showOptionsSyncFeedback(res: SyncResult, initialLabel = false): void {
  feedbackEl.innerHTML = '';
  if (res.pullRequestUrl && isSafeHttpUrl(res.pullRequestUrl)) {
    feedbackEl.append(
      document.createTextNode(
        `Proposed PR${res.pullRequestNumber ? ` #${res.pullRequestNumber}` : ''}: `,
      ),
    );
    const prA = document.createElement('a');
    prA.href = res.pullRequestUrl;
    prA.target = '_blank';
    prA.rel = 'noopener noreferrer';
    prA.textContent = res.pullRequestUrl;
    feedbackEl.append(prA);
  } else {
    feedbackEl.textContent = res.committed
      ? `${initialLabel ? 'Initial sync committed' : 'Synced cleanly'} (${res.commitSha?.slice(0, 7) ?? ''}).`
      : initialLabel
        ? 'Initial sync complete.'
        : 'Sync complete.';
  }
}

document.getElementById('btn-sync-profile')?.addEventListener('click', async () => {
  try {
    const profile = buildProfileFromForm();
    await ensureOriginPermission(profile.instanceUrl);
    state = await sendRpc<ExtensionStatePayload>({ type: 'SAVE_PROFILE', profile });
    editingProfileId = profile.id;
    renderState();

    const hasSnapshot = Boolean(state.snapshots[profile.id]);
    if (
      !hasSnapshot &&
      profile.safety.previewFirstSync &&
      profile.syncMode !== 'subscribe-only'
    ) {
      feedbackEl.textContent = 'Computing dry-run preview…';
      const preview = await sendRpc<DryRunPreviewPayload>({
        type: 'RUN_DRY_RUN',
        profileId: profile.id,
      });
      feedbackEl.textContent = '';
      renderPreviewModal(preview);
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
    showOptionsSyncFeedback(res, false);
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
    showOptionsSyncFeedback(res, true);
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

function applyGardenManifestToForm(manifest: GlyphrigGardenManifest): void {
  loadProfileIntoForm(null);
  nameInput.value = manifest.title || `${manifest.owner}/${manifest.repo}`;
  forgeSelect.value = manifest.forge;
  ownerInput.value = manifest.owner;
  repoInput.value = manifest.repo;
  branchInput.value = manifest.branch || 'main';
  rootDirInput.value = manifest.rootDir || 'bookmarks';
  instanceInput.value = manifest.instanceUrl ?? '';
  siteUrlInput.value = manifest.siteUrl ?? '';
  syncModeSelect.value = manifest.recommendedSyncMode ?? 'subscribe-only';

  // Always reset auth state from loadProfileIntoForm(null) before matching manifest forge/mode
  selectedAccountId = '';
  verifiedUsername = '';
  authMethod = 'pat';

  if (manifest.forge === 'github' && syncModeSelect.value !== 'subscribe-only') {
    const targetHost = normalizeGitHubInstance(manifest.instanceUrl);
    const matching = (state?.sharedAccounts ?? []).find(
      (a) => normalizeGitHubInstance(a.instanceUrl) === targetHost,
    );
    if (matching) {
      selectedAccountId = matching.id;
      authMethod = matching.authMethod;
      verifiedUsername = matching.username ?? '';
    }
  }

  renderVerifiedUsername();
  updateForgeUi();
  renderState();
  feedbackEl.textContent = `Loaded "${manifest.title}" (${manifest.owner}/${manifest.repo}). Choose a local bookmark folder and click Save Profile!`;
}

joinGardenBtn?.addEventListener('click', async () => {
  const raw = joinGardenInput.value.trim();
  if (!raw) {
    joinGardenStatusEl.textContent = 'Paste a glyphrig-invite:... code or a site URL.';
    return;
  }
  joinGardenBtn.disabled = true;
  joinGardenStatusEl.textContent = 'Loading garden details…';
  try {
    let manifest = decodeGlyphrigInvite(raw);
    if (!manifest && isSafeHttpUrl(raw)) {
      const parsed = new URL(raw);
      let targetUrl: string;
      if (parsed.pathname.toLowerCase().endsWith('.json')) {
        targetUrl = parsed.toString();
      } else {
        parsed.search = '';
        parsed.hash = '';
        if (!parsed.pathname.endsWith('/')) {
          parsed.pathname += '/';
        }
        targetUrl = new URL('glyphrig.json', parsed).toString();
      }
      await ensureOriginPermission(targetUrl);
      manifest = await sendRpc<GlyphrigGardenManifest>({
        type: 'FETCH_GARDEN_MANIFEST',
        url: targetUrl,
      });
    }
    if (!manifest) {
      throw new Error('Unrecognized invite code or glyphrig.json URL.');
    }
    applyGardenManifestToForm(manifest);
    joinGardenInput.value = '';
    joinGardenStatusEl.textContent = `Ready to join ${manifest.owner}/${manifest.repo}!`;
  } catch (err) {
    joinGardenStatusEl.textContent =
      err instanceof Error ? err.message : 'Failed to load garden invite.';
  } finally {
    joinGardenBtn.disabled = false;
  }
});

liveBadgeCheck?.addEventListener('change', async () => {
  const desired = liveBadgeCheck.checked;
  liveBadgeStatusEl.textContent = '';
  try {
    if (desired && browser.permissions?.request) {
      const granted = await browser.permissions.request({ permissions: ['tabs'] });
      if (!granted) {
        liveBadgeCheck.checked = false;
        liveBadgeStatusEl.textContent = 'Tabs permission was not granted; live badge remains off.';
        return;
      }
    }
    state = await sendRpc<ExtensionStatePayload>({
      type: 'SET_LIVE_PAGE_BADGE',
      enabled: desired,
    });
    liveBadgeStatusEl.textContent = desired
      ? 'Enabled — toolbar badge will display teammate save counts locally.'
      : 'Disabled.';
  } catch (err) {
    liveBadgeCheck.checked = !desired;
    liveBadgeStatusEl.textContent =
      err instanceof Error ? err.message : 'Failed to update live badge setting.';
  }
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
