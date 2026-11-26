import { buildRssXml, siteData, sortRecentBookmarks, toAbsoluteUrl } from '../lib/data.js';

export function GET() {
  const channelLink = toAbsoluteUrl('');
  const items = sortRecentBookmarks(siteData.allBookmarks);

  const rss = buildRssXml({
    title: siteData.config.site.title,
    description: siteData.config.site.description,
    link: channelLink,
    items,
  });

  return new Response(rss, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
