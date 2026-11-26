import { decodeBase64ToUtf8, encodeRefPath, encodeUtf8ToBase64 } from './forge/encoding.js';
import { formatBookmarkLine } from './markdown/serialize.js';
import { folderPathToFilePath } from './markdown/slug.js';
import { isSafeHttpUrl } from './safety/filter.js';
import type { ForgeKind, GlyphrigGardenManifest, SyncMode } from './types.js';

const INVITE_PREFIX = 'glyphrig-invite:';
const VALID_FORGES = new Set<ForgeKind>(['github', 'gitlab', 'forgejo']);
const VALID_SYNC_MODES = new Set<SyncMode>([
  'two-way',
  'contribute-only',
  'subscribe-only',
  'propose-pr',
]);

function toBase64Url(str: string): string {
  return encodeUtf8ToBase64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return decodeBase64ToUtf8(padded + '='.repeat(padLen));
}

function normalizeSafeUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !isSafeHttpUrl(trimmed)) return undefined;
  return trimmed;
}

export function parseGlyphrigManifest(raw: unknown): GlyphrigGardenManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const forge = typeof obj.forge === 'string' ? (obj.forge.trim() as ForgeKind) : null;
  const owner = typeof obj.owner === 'string' ? obj.owner.trim() : '';
  const repo = typeof obj.repo === 'string' ? obj.repo.trim() : '';

  if (!forge || !VALID_FORGES.has(forge) || !owner || !repo) {
    return null;
  }

  const branch =
    typeof obj.branch === 'string' && obj.branch.trim() ? obj.branch.trim() : 'main';
  const rootDir =
    typeof obj.rootDir === 'string' && obj.rootDir.trim()
      ? obj.rootDir.trim()
      : 'bookmarks';
  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim()
      : `${owner}/${repo}`;

  const rawMode =
    typeof obj.recommendedSyncMode === 'string'
      ? (obj.recommendedSyncMode.trim() as SyncMode)
      : undefined;
  const recommendedSyncMode =
    rawMode && VALID_SYNC_MODES.has(rawMode) ? rawMode : undefined;

  const siteUrl = normalizeSafeUrl(obj.siteUrl);
  const instanceUrl = normalizeSafeUrl(obj.instanceUrl);

  return {
    version: 1,
    title,
    ...(typeof obj.description === 'string' && obj.description.trim()
      ? { description: obj.description.trim() }
      : {}),
    ...(siteUrl ? { siteUrl } : {}),
    forge,
    ...(instanceUrl ? { instanceUrl } : {}),
    owner,
    repo,
    branch,
    rootDir,
    ...(recommendedSyncMode ? { recommendedSyncMode } : {}),
    ...(typeof obj.bookmarkCount === 'number' ? { bookmarkCount: obj.bookmarkCount } : {}),
    ...(typeof obj.contributorCount === 'number'
      ? { contributorCount: obj.contributorCount }
      : {}),
  };
}

export function encodeGlyphrigInvite(manifest: GlyphrigGardenManifest): string {
  const safeSiteUrl = normalizeSafeUrl(manifest.siteUrl);
  const safeInstanceUrl = normalizeSafeUrl(manifest.instanceUrl);
  const compact: Record<string, unknown> = {
    version: 1,
    title: manifest.title,
    forge: manifest.forge,
    owner: manifest.owner,
    repo: manifest.repo,
    branch: manifest.branch || 'main',
    rootDir: manifest.rootDir || 'bookmarks',
    ...(safeInstanceUrl ? { instanceUrl: safeInstanceUrl } : {}),
    ...(safeSiteUrl ? { siteUrl: safeSiteUrl } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.recommendedSyncMode
      ? { recommendedSyncMode: manifest.recommendedSyncMode }
      : {}),
  };
  return `${INVITE_PREFIX}${toBase64Url(JSON.stringify(compact))}`;
}

export function decodeGlyphrigInvite(input: string): GlyphrigGardenManifest | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(INVITE_PREFIX)) {
    try {
      const json = fromBase64Url(trimmed.slice(INVITE_PREFIX.length));
      return parseGlyphrigManifest(JSON.parse(json));
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('glyphrig://')) {
    try {
      const parsed = new URL(trimmed);
      return parseGlyphrigManifest({
        forge: parsed.searchParams.get('forge') || 'github',
        instanceUrl: parsed.searchParams.get('instanceUrl') || undefined,
        owner: parsed.searchParams.get('owner') || '',
        repo: parsed.searchParams.get('repo') || '',
        branch: parsed.searchParams.get('branch') || 'main',
        rootDir: parsed.searchParams.get('rootDir') || 'bookmarks',
        title: parsed.searchParams.get('title') || undefined,
        siteUrl: parsed.searchParams.get('siteUrl') || undefined,
        recommendedSyncMode: parsed.searchParams.get('mode') || undefined,
      });
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      return parseGlyphrigManifest(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  return null;
}

function resolveWebForgeBase(forge: ForgeKind, instanceUrl?: string): string {
  const fallback =
    forge === 'github'
      ? 'https://github.com'
      : forge === 'gitlab'
        ? 'https://gitlab.com'
        : 'https://codeberg.org';
  const raw = normalizeSafeUrl(instanceUrl);
  if (!raw) return fallback;
  let cleaned = raw.replace(/\/+$/, '').replace(/\/api\/v[134]$/i, '');
  if (cleaned === 'https://api.github.com') {
    cleaned = 'https://github.com';
  }
  return cleaned;
}

export function buildSuggestBookmarkUrl(
  repoConfig: {
    forge: ForgeKind;
    instanceUrl?: string;
    owner: string;
    repo: string;
    branch?: string;
    rootDir?: string;
  },
  entry: {
    title: string;
    url: string;
    folderPath?: string;
    note?: string;
    tags?: string[];
  },
): string {
  const targetFile = folderPathToFilePath(
    repoConfig.rootDir || 'bookmarks',
    entry.folderPath || '',
  );
  const markdownLine = formatBookmarkLine({
    title: entry.title || entry.url,
    url: entry.url,
    normalizedUrl: entry.url,
    ...(entry.note ? { note: entry.note } : {}),
    tags: entry.tags ?? [],
    added: new Date().toISOString().slice(0, 10),
    order: 0,
  });

  const issueTitle = `Bookmark suggestion: ${entry.title || entry.url}`;
  const issueBody = [
    'Suggested bookmark via Glyphrig:',
    '',
    `- **Target file:** \`${targetFile}\``,
    `- **URL:** ${entry.url}`,
    ...(entry.note ? [`- **Note:** ${entry.note}`] : []),
    '',
    'Markdown entry ready to paste:',
    '```markdown',
    markdownLine,
    '```',
  ].join('\n');

  const baseHost = resolveWebForgeBase(repoConfig.forge, repoConfig.instanceUrl);
  const repoPath = `${encodeRefPath(repoConfig.owner)}/${encodeURIComponent(repoConfig.repo)}`;

  if (repoConfig.forge === 'gitlab') {
    const params = new URLSearchParams({
      'issue[title]': issueTitle,
      'issue[description]': issueBody,
    });
    return `${baseHost}/${repoPath}/-/issues/new?${params.toString()}`;
  }

  const params = new URLSearchParams({
    title: issueTitle,
    body: issueBody,
  });
  return `${baseHost}/${repoPath}/issues/new?${params.toString()}`;
}
