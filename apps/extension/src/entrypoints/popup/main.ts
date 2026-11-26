import { isSafeHttpUrl, type SyncMode, type SyncResult } from '@glyphrig/core';
import { browser } from 'wxt/browser';
import type {
  ExtensionMessage,
  ExtensionStatePayload,
  PageInspectionPayload,
  SaveAndAnnotateResult,
} from '../../lib/messages.js';

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
const syncAllBtn = document.getElementById('btn-sync-all') as HTMLButtonElement;
const siteLink = document.getElementById('link-site') as HTMLAnchorElement;
const feedbackEl = document.getElementById('popup-feedback')!;

const teamMatchCard = document.getElementById('team-match-card')!;
const teamMatchHeading = document.getElementById('team-match-heading')!;
const teamMatchBadge = document.getElementById('team-match-badge')!;
const teamMatchList = document.getElementById('team-match-list')!;

const quickSaveCard = document.getElementById('quick-save-card')!;
const quickSaveHeading = document.getElementById('quick-save-heading')!;
const quickSaveForm = document.getElementById('quick-save-form') as HTMLFormElement;
const qsTitleInput = document.getElementById('qs-title') as HTMLInputElement;
const qsFolderSelect = document.getElementById('qs-folder') as HTMLSelectElement;
const qsNoteInput = document.getElementById('qs-note') as HTMLInputElement;
const qsTagsInput = document.getElementById('qs-tags') as HTMLInputElement;
const qsTagSuggestions = document.getElementById('qs-tag-suggestions')!;
const qsReadonlyHint = document.getElementById('qs-readonly-hint')!;
const qsSubmitBtn = document.getElementById('btn-quick-save') as HTMLButtonElement;

let currentState: ExtensionStatePayload | null = null;
let activeTabUrl = '';
let activeTabTitle = '';
let pageInspection: PageInspectionPayload | null = null;
let lastRenderedProfileId: string | null = null;

function formatModeLabel(mode?: SyncMode): string {
  switch (mode) {
    case 'contribute-only':
      return 'Contribute';
    case 'subscribe-only':
      return 'Subscribe (Read-Only)';
    case 'propose-pr':
      return 'Propose PR';
    default:
      return 'Two-Way';
  }
}

async function openOptions(): Promise<void> {
  try {
    await browser.tabs.create({ url: browser.runtime.getURL('/options.html') });
    window.close();
  } catch {
    await browser.runtime.openOptionsPage();
  }
}

function renderTagSuggestions(profileId: string): void {
  const allTags = pageInspection?.tagsByProfile[profileId] ?? [];
  const typedParts = qsTagsInput.value.split(',');
  const currentFragment = (typedParts[typedParts.length - 1] ?? '').trim().replace(/^#/, '').toLowerCase();
  const alreadyChosen = new Set(
    typedParts
      .slice(0, -1)
      .map((t) => t.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  );

  const suggestions = allTags
    .filter((t) => !alreadyChosen.has(t) && (!currentFragment || t.includes(currentFragment)))
    .slice(0, 8);

  qsTagSuggestions.innerHTML = '';
  if (suggestions.length === 0) {
    qsTagSuggestions.hidden = true;
    return;
  }

  qsTagSuggestions.hidden = false;
  for (const tag of suggestions) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip';
    chip.textContent = `#${tag}`;
    chip.addEventListener('click', () => {
      const next = [...alreadyChosen, tag];
      qsTagsInput.value = `${next.join(', ')}, `;
      qsTagsInput.focus();
      renderTagSuggestions(profileId);
    });
    qsTagSuggestions.append(chip);
  }
}

function renderActiveTabSection(state: ExtensionStatePayload): void {
  if (!activeTabUrl || !/^https?:\/\//i.test(activeTabUrl)) {
    teamMatchCard.hidden = true;
    quickSaveCard.hidden = true;
    return;
  }

  const active =
    state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0]!;
  const matches = pageInspection?.matches ?? [];

  if (matches.length > 0) {
    teamMatchCard.hidden = false;
    const allUsers = new Set<string>();
    for (const m of matches) {
      for (const u of m.savedBy) allUsers.add(u);
    }
    const count = allUsers.size > 0 ? allUsers.size : matches.length;
    teamMatchBadge.textContent = `★ ${count}`;
    teamMatchHeading.textContent =
      allUsers.size > 0
        ? `Saved by ${[...allUsers].map((u) => `@${u}`).join(', ')}`
        : `Already saved in ${matches.length} garden${matches.length === 1 ? '' : 's'}`;

    teamMatchList.innerHTML = '';
    for (const m of matches) {
      const item = document.createElement('div');
      item.className = 'team-match-item';

      const loc = document.createElement('div');
      loc.className = 'small';
      const profileStrong = document.createElement('strong');
      profileStrong.textContent = m.profileName;
      const folderSpan = document.createElement('span');
      folderSpan.textContent = m.folderTitle;
      loc.append(profileStrong, document.createTextNode(' · '), folderSpan);
      item.append(loc);

      if (m.note) {
        const noteEl = document.createElement('p');
        noteEl.className = 'small muted';
        noteEl.textContent = m.note;
        item.append(noteEl);
      }

      if (m.contributorNotes) {
        for (const [u, text] of Object.entries(m.contributorNotes)) {
          const line = document.createElement('p');
          line.className = 'small team-note-line';
          const author = document.createElement('strong');
          author.textContent = `@${u}: `;
          line.append(author, document.createTextNode(text));
          item.append(line);
        }
      }

      if (m.tags.length > 0) {
        const tagLine = document.createElement('div');
        tagLine.className = 'small muted';
        tagLine.textContent = m.tags.map((t) => `#${t}`).join(' ');
        item.append(tagLine);
      }

      teamMatchList.append(item);
    }
    quickSaveHeading.textContent = 'Add Your Note / Update Tags';
  } else {
    teamMatchCard.hidden = true;
    quickSaveHeading.textContent = 'Save & Annotate Tab';
  }

  const profileSwitched = lastRenderedProfileId !== active.id;
  lastRenderedProfileId = active.id;

  quickSaveCard.hidden = false;
  if (profileSwitched) {
    qsTitleInput.value = activeTabTitle || activeTabUrl;
    qsNoteInput.value = '';
    qsTagsInput.value = '';
  } else if (!qsTitleInput.value) {
    qsTitleInput.value = activeTabTitle || activeTabUrl;
  }

  const subfolders = pageInspection?.subfoldersByProfile[active.id] ?? [
    { path: '', title: active.rootFolderTitle || active.name },
  ];
  const prevFolder = profileSwitched ? '' : qsFolderSelect.value;
  qsFolderSelect.innerHTML = '';
  for (const sf of subfolders) {
    const opt = document.createElement('option');
    opt.value = sf.path;
    opt.textContent = sf.title;
    qsFolderSelect.append(opt);
  }
  const activeProfileMatch = matches.find((m) => m.profileId === active.id);
  if (activeProfileMatch) {
    qsFolderSelect.value = activeProfileMatch.folderPath;
    if (!qsTagsInput.value && activeProfileMatch.tags.length > 0) {
      qsTagsInput.value = activeProfileMatch.tags.join(', ');
    }
  } else if (prevFolder && subfolders.some((sf) => sf.path === prevFolder)) {
    qsFolderSelect.value = prevFolder;
  }

  const isReadOnly = active.syncMode === 'subscribe-only';
  qsReadonlyHint.hidden = !isReadOnly;
  qsSubmitBtn.disabled = isReadOnly;
  qsSubmitBtn.textContent =
    active.syncMode === 'propose-pr' ? 'Save & Propose PR' : 'Save & Sync';

  renderTagSuggestions(active.id);
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

  selectWrap.hidden = false;
  profileSelect.innerHTML = '';
  for (const p of state.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${formatModeLabel(p.syncMode)})`;
    opt.selected = p.id === state.activeProfileId;
    profileSelect.append(opt);
  }

  const active =
    state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0]!;
  const snap = state.snapshots[active.id];
  const dirty = state.dirtyProfiles[active.id] ?? 0;
  const lastLog = state.history.find((h) => h.profileId === active.id);
  const needsPreview = !snap && active.safety.previewFirstSync && active.syncMode !== 'subscribe-only';

  repoLabel.textContent = `${active.forge}: ${active.owner}/${active.repo}`;
  folderLabel.textContent = `Folder: ${active.rootFolderTitle || active.rootFolderId} -> ${active.rootDir}/`;
  lastSyncLabel.textContent = snap
    ? `Last sync: ${new Date(snap.lastSyncedAt).toLocaleString()}`
    : 'Never synced yet';

  previewNotice.hidden = !needsPreview;
  syncBtn.textContent = needsPreview
    ? 'Preview First Sync'
    : active.syncMode === 'subscribe-only'
      ? 'Pull Updates'
      : active.syncMode === 'propose-pr'
        ? 'Sync & Propose PR'
        : 'Sync Now';
  syncAllBtn.hidden = state.profiles.filter((p) => p.enabled).length <= 1;

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
    statusBadge.textContent = active.syncMode === 'subscribe-only' ? 'Subscribed' : 'Synced';
    statusBadge.classList.add('is-ok');
  } else {
    statusBadge.textContent = 'New';
  }

  if (active.siteUrl && isSafeHttpUrl(active.siteUrl)) {
    siteLink.href = active.siteUrl;
    siteLink.hidden = false;
  } else {
    siteLink.removeAttribute('href');
    siteLink.hidden = true;
  }

  renderActiveTabSection(state);
}

function showSyncFeedback(res: SyncResult): void {
  feedbackEl.innerHTML = '';
  if (res.pullRequestUrl && isSafeHttpUrl(res.pullRequestUrl)) {
    const text = document.createTextNode(
      `Proposed PR${res.pullRequestNumber ? ` #${res.pullRequestNumber}` : ''}: `,
    );
    const a = document.createElement('a');
    a.href = res.pullRequestUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'View Pull Request';
    feedbackEl.append(text, a);
    return;
  }
  feedbackEl.textContent = res.committed
    ? `Synced (${res.commitSha?.slice(0, 7) ?? ''}).`
    : res.localPatchNeeded
      ? 'Pulled updates to browser folder.'
      : 'Already up to date.';
}

document.getElementById('btn-open-options')?.addEventListener('click', openOptions);
document.getElementById('btn-setup')?.addEventListener('click', openOptions);

profileSelect.addEventListener('change', async () => {
  try {
    const next = await sendRpc<ExtensionStatePayload>({
      type: 'SET_ACTIVE_PROFILE',
      profileId: profileSelect.value,
    });
    render(next);
  } catch (err) {
    feedbackEl.textContent =
      err instanceof Error ? err.message : 'Failed to switch profile.';
  }
});

qsTagsInput.addEventListener('input', () => {
  if (!currentState) return;
  const active =
    currentState.profiles.find((p) => p.id === currentState?.activeProfileId) ??
    currentState.profiles[0];
  if (active) renderTagSuggestions(active.id);
});

quickSaveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentState || !activeTabUrl) return;
  const active =
    currentState.profiles.find((p) => p.id === currentState?.activeProfileId) ??
    currentState.profiles[0];
  if (!active || active.syncMode === 'subscribe-only') return;

  const tags = qsTagsInput.value
    .split(',')
    .map((t) => t.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
  const noteText = qsNoteInput.value.trim();

  qsSubmitBtn.disabled = true;
  feedbackEl.textContent = 'Saving bookmark & note…';

  try {
    const res = await sendRpc<SaveAndAnnotateResult>({
      type: 'SAVE_AND_ANNOTATE_PAGE',
      profileId: active.id,
      folderPath: qsFolderSelect.value || '',
      url: activeTabUrl,
      title: qsTitleInput.value.trim() || activeTabTitle || activeTabUrl,
      ...(noteText ? { contributorNote: noteText } : {}),
      tags,
      syncNow: true,
    });
    qsNoteInput.value = '';
    pageInspection = await sendRpc<PageInspectionPayload>({
      type: 'INSPECT_PAGE_URL',
      url: activeTabUrl,
    });
    render(res.state);
    if (res.syncResult) {
      showSyncFeedback(res.syncResult);
    } else {
      feedbackEl.textContent = 'Saved to folder & queued note (run dry-run preview in Settings for first sync).';
    }
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Save failed.';
  } finally {
    const latestActive =
      currentState?.profiles.find((p) => p.id === currentState?.activeProfileId) ??
      currentState?.profiles[0];
    qsSubmitBtn.disabled = !latestActive || latestActive.syncMode === 'subscribe-only';
  }
});

syncBtn.addEventListener('click', async () => {
  const snapshotState = currentState;
  if (!snapshotState) return;
  const active =
    snapshotState.profiles.find((p) => p.id === snapshotState.activeProfileId) ??
    snapshotState.profiles[0];
  if (!active) return;

  const snap = snapshotState.snapshots[active.id];
  if (!snap && active.safety.previewFirstSync && active.syncMode !== 'subscribe-only') {
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
    showSyncFeedback(res);
    if (activeTabUrl) {
      pageInspection = await sendRpc<PageInspectionPayload>({
        type: 'INSPECT_PAGE_URL',
        url: activeTabUrl,
      });
    }
    render(await sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' }));
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Sync failed.';
  } finally {
    syncBtn.disabled = false;
  }
});

syncAllBtn.addEventListener('click', async () => {
  syncAllBtn.disabled = true;
  syncBtn.disabled = true;
  feedbackEl.textContent = 'Syncing all enabled profiles…';
  try {
    const res = await sendRpc<{
      synced: number;
      failed: Array<{ profileId: string; name: string; error: string }>;
    }>({ type: 'RUN_SYNC_ALL' });
    feedbackEl.textContent =
      res.failed.length > 0
        ? `Synced ${res.synced}; ${res.failed.length} failed (${res.failed.map((f) => f.name).join(', ')}).`
        : `Synced all ${res.synced} profile(s).`;
    render(await sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' }));
  } catch (err) {
    feedbackEl.textContent = err instanceof Error ? err.message : 'Sync all failed.';
  } finally {
    syncAllBtn.disabled = false;
    syncBtn.disabled = false;
  }
});

async function bootstrap(): Promise<void> {
  const [state, activeTabs] = await Promise.all([
    sendRpc<ExtensionStatePayload>({ type: 'GET_STATE' }),
    browser.tabs.query({ active: true, currentWindow: true }).catch(() => []),
  ]);
  const tab = activeTabs[0];
  activeTabUrl = tab?.url ?? '';
  activeTabTitle = tab?.title ?? '';
  if (activeTabUrl && /^https?:\/\//i.test(activeTabUrl)) {
    pageInspection = await sendRpc<PageInspectionPayload>({
      type: 'INSPECT_PAGE_URL',
      url: activeTabUrl,
    }).catch(() => null);
  }
  render(state);
}

void bootstrap().catch((err) => {
  feedbackEl.textContent = err instanceof Error ? err.message : 'Failed to load state.';
});
