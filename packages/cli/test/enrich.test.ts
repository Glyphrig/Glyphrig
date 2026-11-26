import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichBookmarks, sanitizeSvgFavicon } from '../src/enrich.js';

const tempDirs: string[] = [];
const servers: http.Server[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glyphrig-enrich-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('URL enrichment and disk caching', () => {
  it('fetches HTML metadata + favicon, caches hits on second run, and tolerates errors', async () => {
    const cacheDir = await makeTempDir();
    let pageHits = 0;

    const server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        pageHits++;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head>
          <title>Mock Page &amp; Guide</title>
          <meta content="Helpful guide description" name="description">
          <meta property="og:image" content="/og.png">
          <meta name="keywords" content="rust, cli, tools">
          <link rel="icon" href="/icon.svg">
        </head><body><p>Hello</p></body></html>`);
        return;
      }
      if (req.url === '/icon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>');
        return;
      }
      if (req.url === '/binary.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end('%PDF-1.4 mock binary');
        return;
      }
      res.writeHead(500);
      res.end('Internal Error');
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected port');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const urls = [`${baseUrl}/ok`, `${baseUrl}/binary.pdf`, `${baseUrl}/fail`];
    const first = await enrichBookmarks(urls, {
      cacheDir,
      enabled: true,
      fetchFavicons: true,
      fetchOgImage: true,
      autoTags: true,
      concurrency: 4,
      timeoutMs: 3000,
      ttlDays: 30,
      allowPrivateUrlsForTest: true,
    });

    expect(pageHits).toBe(1);
    expect(first.stats.fetchedOk).toBe(2);
    expect(first.stats.failed).toBe(1);

    const okMeta = first.metadata.get(`${baseUrl}/ok`);
    expect(okMeta?.title).toBe('Mock Page & Guide');
    expect(okMeta?.description).toBe('Helpful guide description');
    expect(okMeta?.ogImage).toBe(`${baseUrl}/og.png`);
    expect(okMeta?.keywords).toEqual(['rust', 'cli', 'tools']);
    expect(okMeta?.faviconRelPath).toMatch(/^favicons\/[a-f0-9]+\.svg$/);

    // Second run must hit cache without hitting HTTP server again
    const second = await enrichBookmarks(urls, {
      cacheDir,
      enabled: true,
      fetchFavicons: true,
      fetchOgImage: true,
      autoTags: true,
      concurrency: 4,
      timeoutMs: 3000,
      ttlDays: 30,
      allowPrivateUrlsForTest: true,
    });

    expect(pageHits).toBe(1);
    expect(second.stats.cacheHits).toBe(3);
  });

  it('blocks private/localhost URLs by default via SSRF guard', async () => {
    const cacheDir = await makeTempDir();
    const res = await enrichBookmarks(['http://127.0.0.1:9999/secret', 'http://localhost:3000'], {
      cacheDir,
      enabled: true,
      fetchFavicons: true,
      fetchOgImage: true,
      autoTags: false,
      concurrency: 2,
      timeoutMs: 1000,
      ttlDays: 30,
    });

    expect(res.stats.skippedUnsafe).toBe(2);
    expect(res.stats.fetchedOk).toBe(0);
  });

  it('rejects malicious SVG favicons containing scripts, event handlers, or external hrefs', () => {
    const enc = new TextEncoder();
    const clean = enc.encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
    );
    expect(sanitizeSvgFavicon(clean)).not.toBeNull();

    const payloads = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="16" height="16"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#i"/></svg>',
      '<?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ];
    for (const p of payloads) {
      expect(sanitizeSvgFavicon(enc.encode(p))).toBeNull();
    }
  });
});
