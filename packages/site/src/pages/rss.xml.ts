import { escapeXml, folderHref, siteData, sortRecentBookmarks, withBase } from '../lib/data.js';

export function GET() {
  const siteBaseUrl = siteData.config.site.url?.replace(/\/+$/, '') || '';
  const channelLink = siteBaseUrl ? `${siteBaseUrl}${withBase('')}` : withBase('');
  const items = sortRecentBookmarks(siteData.allBookmarks).slice(0, 100);

  const xmlItems = items
    .map((bm) => {
      const pubDate = bm.added ? new Date(`${bm.added}T12:00:00Z`) : new Date(siteData.generatedAt);
      const validDate = Number.isNaN(pubDate.getTime())
        ? new Date(siteData.generatedAt)
        : pubDate;
      const folderLink = siteBaseUrl
        ? `${siteBaseUrl}${folderHref(bm.folderPath)}`
        : folderHref(bm.folderPath);
      const desc = bm.effectiveDescription
        ? `${bm.effectiveDescription} (Folder: ${bm.folderTitle})`
        : `Bookmarked in ${bm.folderTitle}`;
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

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(siteData.config.site.title)}</title>
    <description>${escapeXml(siteData.config.site.description)}</description>
    <link>${escapeXml(channelLink)}</link>
    <lastBuildDate>${new Date(siteData.generatedAt).toUTCString()}</lastBuildDate>
${xmlItems}
  </channel>
</rss>
`;

  return new Response(rss, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
