import {
  siteData,
  sortRecentBookmarks,
  toAbsoluteUrl,
  toValidIsoDate,
} from '../lib/data.js';

export function GET() {
  const homeUrl = toAbsoluteUrl('');
  const feedUrl = toAbsoluteUrl('feed.json');
  const items = sortRecentBookmarks(siteData.allBookmarks).slice(0, 100);

  const payload = {
    version: 'https://jsonfeed.org/version/1.1',
    title: siteData.config.site.title,
    home_page_url: homeUrl,
    feed_url: feedUrl,
    description: siteData.config.site.description,
    items: items.map((bm) => ({
      id: bm.id,
      url: bm.url,
      title: bm.title,
      content_text: bm.effectiveDescription || bm.domain,
      date_published: toValidIsoDate(bm.added, siteData.generatedAt),
      tags: bm.tags,
      _glyphrig: {
        folderPath: bm.folderPath,
        folderTitle: bm.folderTitle,
      },
    })),
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: { 'Content-Type': 'application/feed+json; charset=utf-8' },
  });
}
