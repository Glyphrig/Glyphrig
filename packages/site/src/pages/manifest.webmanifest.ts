import { siteData, withBase } from '../lib/data.js';

export function GET() {
  const iconHref = siteData.hasCustomFaviconAsset
    ? withBase('assets/favicon.svg')
    : withBase('glyphrig-icon.svg');

  const manifest = {
    name: siteData.config.site.title,
    short_name: siteData.config.site.title.slice(0, 16),
    description: siteData.config.site.description,
    start_url: withBase(''),
    scope: withBase(''),
    display: 'standalone',
    background_color: '#faf8f5',
    theme_color: siteData.config.theme.accent || '#b45309',
    icons: [
      {
        src: iconHref,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
    share_target: {
      action: withBase(''),
      method: 'GET',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
      },
    },
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
  });
}
