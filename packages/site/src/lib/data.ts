import { siteData } from 'virtual:glyphrig-data';
import type { EnrichedBookmark, EnrichedFolderNode, SiteCollaborationConfig } from '../types.js';

export { siteData };

export function normalizeBase(base: string): string {
  let clean = base.trim() || '/';
  clean = clean.replace(/^\/+/, '/');
  if (!clean.startsWith('/')) clean = `/${clean}`;
  if (!clean.endsWith('/')) clean = `${clean}/`;
  return clean;
}

export function withBase(path: string): string {
  const base = normalizeBase(siteData.config.site.base);
  const clean = path.replace(/^\/+/, '');
  if (!clean) {
    return base;
  }
  return `${base}${clean}`;
}

export function isSafeHttpUrl(raw?: string): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function toAbsoluteUrl(relPath: string): string {
  const rel = withBase(relPath);
  const rawSiteUrl = siteData.config.site.url?.trim();
  if (!rawSiteUrl) return rel;
  try {
    const parsed = new URL(rawSiteUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return rel;
    }
    return `${parsed.origin}${rel}`;
  } catch {
    return rel;
  }
}

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function encodePathSegments(folderPath: string): string {
  return folderPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export function folderHref(folderPath: string): string {
  if (!folderPath) {
    return withBase('');
  }
  return withBase(`f/${encodePathSegments(folderPath)}/`);
}

export function tagHref(tagSlug: string): string {
  return withBase(`tags/${encodeURIComponent(tagSlug)}/`);
}

export function contributorHref(userSlug: string): string {
  return withBase(`u/${encodeURIComponent(userSlug)}/`);
}

export function folderFeedHref(folderPath: string): string {
  return withBase(`feeds/f/${encodePathSegments(folderPath)}.xml`);
}

export function tagFeedHref(tagSlug: string): string {
  return withBase(`feeds/tags/${encodeURIComponent(tagSlug)}.xml`);
}

export function contributorFeedHref(userSlug: string): string {
  return withBase(`feeds/u/${encodeURIComponent(userSlug)}.xml`);
}

export function getEffectiveCollaborationConfig(): SiteCollaborationConfig | null {
  if (siteData.config.collaboration) {
    return siteData.config.collaboration;
  }
  const qa = siteData.config.pwa.quickAdd;
  if (qa.enabled && qa.owner && qa.repo && qa.owner !== 'your-username') {
    return {
      forge: qa.forge,
      ...(qa.instanceUrl ? { instanceUrl: qa.instanceUrl } : {}),
      owner: qa.owner,
      repo: qa.repo,
      branch: qa.branch,
      rootDir: qa.rootDir,
      recommendedSyncMode: 'subscribe-only',
      allowSuggestions: true,
    };
  }
  return null;
}

export function isQuickAddUiEnabled(): boolean {
  const qa = siteData.config.pwa.quickAdd;
  const collab = getEffectiveCollaborationConfig();
  const hasQuickAddTarget = qa.enabled && Boolean(qa.owner && qa.repo);
  const hasSuggestTarget = Boolean(collab && collab.allowSuggestions !== false);
  return hasQuickAddTarget || hasSuggestTarget;
}

export function toValidIsoDate(raw?: string, fallback?: string): string {
  const fb = fallback || siteData.generatedAt;
  if (!raw || !raw.trim()) return fb;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
    ? `${raw.trim()}T12:00:00Z`
    : raw.trim();
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? fb : d.toISOString();
}

export function buildRssXml(params: {
  title: string;
  description: string;
  link: string;
  items: EnrichedBookmark[];
}): string {
  const xmlItems = params.items
    .slice(0, 100)
    .map((bm) => {
      const validDate = new Date(toValidIsoDate(bm.added, siteData.generatedAt));
      const folderLink = toAbsoluteUrl(
        bm.folderPath ? `f/${encodePathSegments(bm.folderPath)}/` : '',
      );
      const contributorText = bm.contributorNotes
        ? Object.entries(bm.contributorNotes)
            .map(([u, text]) => `@${u}: ${text}`)
            .join(' | ')
        : '';
      const baseDesc = bm.effectiveDescription
        ? `${bm.effectiveDescription} (Folder: ${bm.folderTitle})`
        : `Bookmarked in ${bm.folderTitle}`;
      const desc = contributorText ? `${baseDesc} — ${contributorText}` : baseDesc;

      return `    <item>
      <title>${escapeXml(bm.title)}</title>
      <link>${escapeXml(bm.url)}</link>
      <guid isPermaLink="false">${escapeXml(bm.id)}</guid>
      <pubDate>${validDate.toUTCString()}</pubDate>
      <description>${escapeXml(desc)}</description>
      <comments>${escapeXml(folderLink)}</comments>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(params.title)}</title>
    <description>${escapeXml(params.description)}</description>
    <link>${escapeXml(params.link)}</link>
    <lastBuildDate>${new Date(siteData.generatedAt).toUTCString()}</lastBuildDate>
${xmlItems}
  </channel>
</rss>
`;
}

export function findFolderByPath(folderPath: string): EnrichedFolderNode | undefined {
  if (!folderPath) return siteData.root;
  return siteData.flatFolders.find((f) => f.path === folderPath);
}

export function getFolderBreadcrumbs(
  folder: EnrichedFolderNode,
): Array<{ title: string; href: string }> {
  const crumbs: Array<{ title: string; href: string }> = [
    { title: siteData.root.title || 'Home', href: withBase('') },
  ];
  if (!folder.path) return crumbs;
  const parts = folder.path.split('/');
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const node = findFolderByPath(acc);
    crumbs.push({
      title: node?.title ?? part,
      href: folderHref(acc),
    });
  }
  return crumbs;
}

export function collectTagsInBookmarks(
  bookmarks: EnrichedBookmark[],
): Array<{ tag: string; slug: string; count: number }> {
  const counts = new Map<string, number>();
  for (const bm of bookmarks) {
    for (const tag of bm.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tagMap = new Map(siteData.tags.map((t) => [t.tag, t.slug]));
  return [...counts.entries()]
    .map(([tag, count]) => ({
      tag,
      slug: tagMap.get(tag) ?? encodeURIComponent(tag),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function escapeXml(str: string): string {
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function sortRecentBookmarks(bookmarks: EnrichedBookmark[]): EnrichedBookmark[] {
  return [...bookmarks].sort((a, b) => {
    const da = a.added ?? '0000-00-00';
    const db = b.added ?? '0000-00-00';
    if (da !== db) return db.localeCompare(da);
    return a.title.localeCompare(b.title);
  });
}

export function deduplicateBookmarksByUrl(bookmarks: EnrichedBookmark[]): EnrichedBookmark[] {
  const byUrl = new Map<string, EnrichedBookmark>();
  for (const bm of bookmarks) {
    const prev = byUrl.get(bm.normalizedUrl);
    if (!prev) {
      byUrl.set(bm.normalizedUrl, {
        ...bm,
        tags: [...bm.tags],
        ...(bm.contributorNotes ? { contributorNotes: { ...bm.contributorNotes } } : {}),
      });
      continue;
    }
    const mergedTags = [...new Set([...prev.tags, ...bm.tags])];
    const mergedNotes =
      prev.contributorNotes || bm.contributorNotes
        ? { ...(prev.contributorNotes ?? {}), ...(bm.contributorNotes ?? {}) }
        : undefined;
    const latestAdded = [prev.added, bm.added]
      .filter((d): d is string => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d)))
      .sort()
      .pop();
    byUrl.set(bm.normalizedUrl, {
      ...prev,
      tags: mergedTags,
      ...(mergedNotes ? { contributorNotes: mergedNotes } : {}),
      ...(latestAdded ? { added: latestAdded } : {}),
      ...(!prev.effectiveDescription && bm.effectiveDescription
        ? { effectiveDescription: bm.effectiveDescription }
        : {}),
      ...(!prev.waybackUrl && bm.waybackUrl ? { waybackUrl: bm.waybackUrl } : {}),
    });
  }
  return [...byUrl.values()];
}

export function sortPopularBookmarks(bookmarks: EnrichedBookmark[]): EnrichedBookmark[] {
  return deduplicateBookmarksByUrl(bookmarks).sort((a, b) => {
    if (a.popularity !== b.popularity) {
      return b.popularity - a.popularity;
    }
    const da = a.added ?? '0000-00-00';
    const db = b.added ?? '0000-00-00';
    if (da !== db) return db.localeCompare(da);
    return a.title.localeCompare(b.title);
  });
}
