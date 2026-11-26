import {
  buildRssXml,
  siteData,
  sortRecentBookmarks,
  toAbsoluteUrl,
} from '../../../lib/data.js';
import type { TagSummary } from '../../../types.js';

export function getStaticPaths() {
  return siteData.tags.map((summary) => ({
    params: { tag: summary.slug },
    props: { summary },
  }));
}

export function GET({ props }: { props: { summary: TagSummary } }) {
  const { summary } = props;
  const link = toAbsoluteUrl(`tags/${encodeURIComponent(summary.slug)}/`);
  const items = sortRecentBookmarks(
    siteData.allBookmarks.filter((b) => b.tags.includes(summary.tag)),
  );

  const rss = buildRssXml({
    title: `#${summary.tag} — ${siteData.config.site.title}`,
    description: `Bookmarks tagged #${summary.tag}`,
    link,
    items,
  });

  return new Response(rss, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
