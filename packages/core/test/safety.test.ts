import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_CONFIG,
  inspectUrlSafety,
  normalizeUrl,
  sanitizeBookmarkTree,
  stripTrackingParams,
} from '../src/index.js';

describe('URL sanitizer and safety rails', () => {
  it('strips tracking parameters while keeping meaningful query params', () => {
    const res = stripTrackingParams(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter&fbclid=123&si=abc',
    );
    expect(res.changed).toBe(true);
    expect(res.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('normalizes scheme, host casing, and default ports', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/')).toBe('https://example.com');
    expect(normalizeUrl('http://example.com:80/docs?a=1#top')).toBe(
      'http://example.com/docs?a=1#top',
    );
  });

  it('blocks non-public schemes and private/local IP hosts', () => {
    const blocked = [
      'chrome://extensions',
      'about:config',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://localhost:3000/admin',
      'http://127.0.0.1:8080',
      'http://10.0.1.5/dashboard',
      'http://172.16.4.2/metrics',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://router.local/',
      'http://intranet/wiki',
      'http://[::1]:5173/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ];

    for (const url of blocked) {
      const check = inspectUrlSafety(url, DEFAULT_SAFETY_CONFIG);
      expect(check.allowed, `Expected ${url} to be blocked`).toBe(false);
    }
  });

  it('blocks embedded credentials and sensitive query parameters', () => {
    expect(inspectUrlSafety('https://alice:s3cr3t@example.com/app').reason).toBe(
      'embedded-credentials',
    );
    expect(inspectUrlSafety('https://example.com/reset?token=xyz123').reason).toBe(
      'sensitive-query-param',
    );
    expect(inspectUrlSafety('https://example.com/data?api_key=abc').reason).toBe(
      'sensitive-query-param',
    );
  });

  it('filters unsafe entries from a BookmarkTree and reports skipped and cleaned URLs', () => {
    const { tree, skipped, cleanedUrls } = sanitizeBookmarkTree({
      root: {
        path: '',
        slug: '',
        title: 'Public',
        order: 0,
        bookmarks: [
          {
            title: 'Local Dev',
            url: 'http://localhost:4321',
            normalizedUrl: 'http://localhost:4321',
            tags: [],
            order: 0,
          },
          {
            title: 'Astro',
            url: 'https://astro.build/blog/?utm_medium=social',
            normalizedUrl: 'https://astro.build/blog/?utm_medium=social',
            tags: [],
            order: 1,
          },
          {
            title: 'Secret Link',
            url: 'https://app.example.com/cb?access_token=secret',
            normalizedUrl: 'https://app.example.com/cb?access_token=secret',
            tags: [],
            order: 2,
          },
        ],
        children: [],
      },
    });

    expect(skipped).toHaveLength(2);
    expect(cleanedUrls).toHaveLength(1);
    expect(cleanedUrls[0]?.cleanedUrl).toBe('https://astro.build/blog/');
    expect(tree.root.bookmarks).toHaveLength(1);
    expect(tree.root.bookmarks[0]?.url).toBe('https://astro.build/blog/');
  });
});
