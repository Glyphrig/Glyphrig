import { siteData } from 'virtual:glyphrig-data';
import type { EnrichedBookmark, EnrichedFolderNode } from '../types.js';

export { siteData };

export function normalizeBase(base: string): string {
  let clean = base.trim() || '/';
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

export function folderHref(folderPath: string): string {
  if (!folderPath) {
    return withBase('');
  }
  return withBase(`f/${folderPath}/`);
}

export function tagHref(tagSlug: string): string {
  return withBase(`tags/${tagSlug}/`);
}

export function contributorHref(userSlug: string): string {
  return withBase(`u/${userSlug}/`);
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
    if (!byUrl.has(bm.normalizedUrl)) {
      byUrl.set(bm.normalizedUrl, bm);
    }
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
