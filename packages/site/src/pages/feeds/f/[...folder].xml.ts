import {
  buildRssXml,
  siteData,
  sortRecentBookmarks,
  toAbsoluteUrl,
} from '../../../lib/data.js';
import type { EnrichedBookmark, EnrichedFolderNode } from '../../../types.js';

function collectSubtreeBookmarks(folder: EnrichedFolderNode): EnrichedBookmark[] {
  const items: EnrichedBookmark[] = [...folder.bookmarks];
  for (const child of folder.children) {
    items.push(...collectSubtreeBookmarks(child));
  }
  return items;
}

export function getStaticPaths() {
  return siteData.flatFolders.map((folder) => ({
    params: { folder: folder.path },
    props: { folder },
  }));
}

export function GET({ props }: { props: { folder: EnrichedFolderNode } }) {
  const { folder } = props;
  const encodedPath = folder.path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const link = toAbsoluteUrl(`f/${encodedPath}/`);
  const items = sortRecentBookmarks(collectSubtreeBookmarks(folder));

  const rss = buildRssXml({
    title: `${folder.title} — ${siteData.config.site.title}`,
    description: folder.description || `Bookmarks in ${folder.title}`,
    link,
    items,
  });

  return new Response(rss, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
