import {
  buildRssXml,
  deduplicateBookmarksByUrl,
  siteData,
  sortRecentBookmarks,
  toAbsoluteUrl,
} from '../../../lib/data.js';
import type { ContributorSummary } from '../../../types.js';

export function getStaticPaths() {
  return siteData.contributors.map((summary) => ({
    params: { user: summary.slug },
    props: { summary },
  }));
}

export function GET({ props }: { props: { summary: ContributorSummary } }) {
  const { summary } = props;
  const link = toAbsoluteUrl(`u/${encodeURIComponent(summary.slug)}/`);
  const items = sortRecentBookmarks(
    deduplicateBookmarksByUrl(
      siteData.allBookmarks.filter((b) => b.globalSavedBy.includes(summary.username)),
    ),
  );

  const rss = buildRssXml({
    title: `@${summary.username} — ${siteData.config.site.title}`,
    description: `Bookmarks saved by @${summary.username}`,
    link,
    items,
  });

  return new Response(rss, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
