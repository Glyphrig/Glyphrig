import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectUrlSafety, mapWithConcurrency } from '@glyphrig/core';

export interface EnrichedUrlMeta {
  url: string;
  status: 'ok' | 'error';
  fetchedAt: number;
  title?: string;
  description?: string;
  ogImage?: string;
  keywords?: string[];
  faviconRelPath?: string;
}

interface MetadataCacheFile {
  version: 1;
  entries: Record<string, EnrichedUrlMeta>;
}

export interface EnrichOptions {
  cacheDir: string;
  enabled: boolean;
  fetchFavicons: boolean;
  fetchOgImage: boolean;
  autoTags: boolean;
  concurrency: number;
  timeoutMs: number;
  ttlDays: number;
  allowPrivateUrlsForTest?: boolean;
}

export interface EnrichStats {
  total: number;
  cacheHits: number;
  fetchedOk: number;
  failed: number;
  skippedUnsafe: number;
}

const MAX_HTML_BYTES = 256 * 1024;
const MAX_FAVICON_BYTES = 64 * 1024;
const ERROR_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'GlyphrigBot/0.1 (+https://github.com/Glyphrig/Glyphrig)';

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return '';
  }
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, '&');
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tag)) !== null) {
    const key = (match[1] ?? '').toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    if (key) {
      attrs[key] = decodeHtmlEntities(val.trim());
    }
  }
  return attrs;
}

export function extractHtmlMetadata(
  html: string,
  baseUrl: string,
): {
  title?: string;
  description?: string;
  ogImage?: string;
  keywords: string[];
  iconCandidates: string[];
} {
  const headEnd = html.search(/<\/head>/i);
  const slice = headEnd !== -1 ? html.slice(0, headEnd + 7) : html;

  let title: string | undefined;
  let ogTitle: string | undefined;
  let description: string | undefined;
  let ogDescription: string | undefined;
  let ogImage: string | undefined;
  let twitterImage: string | undefined;
  const keywordsSet = new Set<string>();
  const iconCandidates: string[] = [];

  const titleMatch = slice.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const cleaned = decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim());
    if (cleaned) title = cleaned;
  }

  const metaTags = slice.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const attrs = parseAttributes(tag);
    const prop = (attrs.property ?? '').toLowerCase();
    const name = (attrs.name ?? '').toLowerCase();
    const content = attrs.content?.trim();
    if (!content) continue;

    if (prop === 'og:title' && !ogTitle) ogTitle = content;
    if (prop === 'og:description' && !ogDescription) ogDescription = content;
    if (name === 'description' && !description) description = content;
    if (prop === 'og:image' && !ogImage) ogImage = content;
    if (name === 'twitter:image' && !twitterImage) twitterImage = content;

    if (name === 'keywords' || prop === 'article:tag') {
      for (const part of content.split(',')) {
        const clean = part.trim().toLowerCase().replace(/\s+/g, '-');
        if (clean && clean.length <= 32) {
          keywordsSet.add(clean);
        }
      }
    }
  }

  const linkTags = slice.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const attrs = parseAttributes(tag);
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    const href = attrs.href?.trim();
    if (!href) continue;
    if (
      rel.includes('icon') ||
      rel.includes('shortcut') ||
      rel.includes('apple-touch-icon')
    ) {
      try {
        iconCandidates.push(new URL(href, baseUrl).toString());
      } catch {
        // ignore invalid icon href
      }
    }
  }

  try {
    iconCandidates.push(new URL('/favicon.ico', baseUrl).toString());
  } catch {
    // ignore
  }

  const resolveOptionalUrl = (candidate?: string): string | undefined => {
    if (!candidate) return undefined;
    try {
      return new URL(candidate, baseUrl).toString();
    } catch {
      return undefined;
    }
  };

  return {
    title: ogTitle || title,
    description: ogDescription || description,
    ogImage: resolveOptionalUrl(ogImage || twitterImage),
    keywords: [...keywordsSet].slice(0, 8),
    iconCandidates: [...new Set(iconCandidates)],
  };
}

async function readHeadLimited(res: Response): Promise<string> {
  if (!res.body) {
    return (await res.text()).slice(0, MAX_HTML_BYTES);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let out = '';

  try {
    while (totalBytes < MAX_HTML_BYTES) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      totalBytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(out)) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength <= maxBytes ? buf : null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function guessIconExtension(contentType: string, iconUrl: string): string | null {
  const ct = contentType.toLowerCase();
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('x-icon') || ct.includes('vnd.microsoft.icon')) return 'ico';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('gif')) return 'gif';

  try {
    const ext = path.extname(new URL(iconUrl).pathname).toLowerCase().replace('.', '');
    if (['svg', 'png', 'ico', 'webp', 'jpg', 'jpeg', 'gif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {
    // ignore
  }
  if (ct.includes('octet-stream')) return 'ico';
  return null;
}

/**
 * Fail-closed validator/sanitizer for SVG favicons served from dist/favicons/.
 * Rejects any SVG containing active scripting, foreignObject, SMIL animation,
 * event handlers, DTD entity declarations, xml-stylesheet PIs, or non-fragment
 * hrefs so an untrusted bookmarked site cannot plant same-origin stored XSS.
 */
export function sanitizeSvgFavicon(bytes: Uint8Array): Uint8Array | null {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Strip UTF-8 BOM and NUL bytes
  text = text.replace(/^\uFEFF/, '').replace(/\u0000/g, '').trim();
  if (!text) return null;

  // Reject DTD internal subsets, entity declarations, and non-xml processing instructions (e.g. <?xml-stylesheet?>)
  if (/<!\s*entity\b/i.test(text) || /<!\s*doctype[^>]*\[/i.test(text)) {
    return null;
  }
  if (/<\?(?!xml(?:\s|$))/i.test(text)) {
    return null;
  }

  // Strip benign XML declaration, comments, and entity-free DOCTYPE to check root element
  const stripped = text
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\s*doctype\s+svg\b[^>]*>/gi, '')
    .trim();

  if (!/^<svg(?:\s|>)/i.test(stripped) || !/<\/svg>\s*$/i.test(stripped)) {
    return null;
  }

  // Reject dangerous elements (script, foreignObject, embedded objects, links, SMIL)
  if (
    /<\s*(?:[a-z0-9_-]+:)?(?:script|foreignobject|iframe|object|embed|applet|meta|link|base|a|animate|animatemotion|animatetransform|set|handler|listener|audio|video)\b/i.test(
      stripped,
    )
  ) {
    return null;
  }

  // Reject inline event handlers (onload=, onerror=, onclick=, etc.)
  if (/(?:^|[\s/"'])on[a-z]{2,}\s*=/i.test(stripped)) {
    return null;
  }

  // Reject dangerous URI schemes, CSS @import / expression(), and CDATA smuggling
  if (
    /<!\[cdata\[/i.test(stripped) ||
    /(?:javascript|vbscript)\s*:/i.test(stripped) ||
    /data\s*:\s*(?:text\/html|image\/svg\+xml|application\/)/i.test(stripped) ||
    /@import\b/i.test(stripped) ||
    /expression\s*\(/i.test(stripped)
  ) {
    return null;
  }

  // Reject any href / xlink:href / src attribute that does not reference a local #id fragment
  const refAttrRegex = /\b(?:(?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of stripped.matchAll(refAttrRegex)) {
    const val = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!val.startsWith('#')) {
      return null;
    }
  }

  return new TextEncoder().encode(stripped);
}

function isUrlAllowedForFetch(url: string, allowPrivateForTest: boolean): boolean {
  if (allowPrivateForTest) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return inspectUrlSafety(url, {
    filterPrivateUrls: true,
    filterCredentials: true,
    stripTrackingParams: false,
  }).allowed;
}

async function fetchWithSafeRedirects(
  startUrl: string,
  init: RequestInit,
  allowPrivateForTest: boolean,
  maxRedirects = 5,
): Promise<{ res: Response; finalUrl: string } | null> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isUrlAllowedForFetch(currentUrl, allowPrivateForTest)) {
      return null;
    }
    const res = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location || hop === maxRedirects) {
        return null;
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return null;
      }
      continue;
    }
    return { res, finalUrl: currentUrl };
  }
  return null;
}

async function downloadFavicon(
  candidates: string[],
  pageUrl: string,
  cacheDir: string,
  timeoutMs: number,
  allowPrivateForTest: boolean,
): Promise<string | undefined> {
  const faviconsDir = path.join(cacheDir, 'favicons');
  await fs.mkdir(faviconsDir, { recursive: true });
  const hashPrefix = crypto
    .createHash('sha256')
    .update(new URL(pageUrl).origin)
    .digest('hex')
    .slice(0, 16);

  for (const candidate of candidates) {
    if (!isUrlAllowedForFetch(candidate, allowPrivateForTest)) {
      continue;
    }
    try {
      const fetched = await fetchWithSafeRedirects(
        candidate,
        {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        },
        allowPrivateForTest,
      );
      if (!fetched) continue;
      const { res, finalUrl } = fetched;
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      const ext = guessIconExtension(contentType, finalUrl);
      if (!ext) {
        await res.body?.cancel().catch(() => {});
        continue;
      }

      let bytes = await readBodyLimited(res, MAX_FAVICON_BYTES);
      if (!bytes || bytes.byteLength === 0) continue;

      if (ext === 'svg') {
        const sanitized = sanitizeSvgFavicon(bytes);
        if (!sanitized) continue;
        bytes = sanitized;
      }

      const fileName = `${hashPrefix}.${ext}`;
      await fs.writeFile(path.join(faviconsDir, fileName), bytes);
      return `favicons/${fileName}`;
    } catch {
      // try next icon candidate
    }
  }
  return undefined;
}

async function loadCache(cacheFile: string): Promise<MetadataCacheFile> {
  try {
    const raw = await fs.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MetadataCacheFile>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // missing or corrupt cache -> start clean
  }
  return { version: 1, entries: {} };
}

async function saveCacheAtomic(cacheFile: string, data: MetadataCacheFile): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const tmpFile = `${cacheFile}.${process.pid}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpFile, cacheFile);
}

export async function enrichBookmarks(
  urls: string[],
  options: EnrichOptions,
): Promise<{ metadata: Map<string, EnrichedUrlMeta>; stats: EnrichStats }> {
  const uniqueUrls = [...new Set(urls)];
  const metadata = new Map<string, EnrichedUrlMeta>();
  const stats: EnrichStats = {
    total: uniqueUrls.length,
    cacheHits: 0,
    fetchedOk: 0,
    failed: 0,
    skippedUnsafe: 0,
  };

  if (!options.enabled || uniqueUrls.length === 0) {
    return { metadata, stats };
  }

  const cacheFile = path.join(options.cacheDir, 'metadata-cache.json');
  const cache = await loadCache(cacheFile);
  const now = Date.now();
  const okTtlMs = options.ttlDays * 24 * 60 * 60 * 1000;
  const allowPrivate = options.allowPrivateUrlsForTest ?? false;

  const toFetch: string[] = [];

  for (const url of uniqueUrls) {
    if (!isUrlAllowedForFetch(url, allowPrivate)) {
      stats.skippedUnsafe++;
      continue;
    }

    const cached = cache.entries[url];
    if (cached) {
      const ttl = cached.status === 'ok' ? okTtlMs : ERROR_TTL_MS;
      const fresh = now - cached.fetchedAt < ttl;
      let faviconReady = true;
      if (fresh && cached.faviconRelPath) {
        try {
          await fs.access(path.join(options.cacheDir, cached.faviconRelPath));
        } catch {
          faviconReady = false;
        }
      }
      if (fresh && faviconReady) {
        metadata.set(url, cached);
        stats.cacheHits++;
        continue;
      }
    }
    toFetch.push(url);
  }

  await mapWithConcurrency(toFetch, options.concurrency, async (url) => {
    const fetchedAt = Date.now();
    try {
      const fetched = await fetchWithSafeRedirects(
        url,
        {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          },
          signal: AbortSignal.timeout(options.timeoutMs),
        },
        allowPrivate,
      );

      if (!fetched || !fetched.res.ok) {
        if (fetched) await fetched.res.body?.cancel().catch(() => {});
        const entry: EnrichedUrlMeta = { url, status: 'error', fetchedAt };
        cache.entries[url] = entry;
        metadata.set(url, entry);
        stats.failed++;
        return;
      }

      const { res, finalUrl } = fetched;

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const isHtml =
        contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
      if (!isHtml) {
        await res.body?.cancel().catch(() => {});
        const entry: EnrichedUrlMeta = { url, status: 'ok', fetchedAt };
        cache.entries[url] = entry;
        metadata.set(url, entry);
        stats.fetchedOk++;
        return;
      }

      const html = await readHeadLimited(res);
      const parsed = extractHtmlMetadata(html, finalUrl);

      const safeOgImage =
        options.fetchOgImage &&
        parsed.ogImage &&
        isUrlAllowedForFetch(parsed.ogImage, allowPrivate)
          ? parsed.ogImage
          : undefined;

      const faviconRelPath = options.fetchFavicons
        ? await downloadFavicon(
            parsed.iconCandidates,
            finalUrl,
            options.cacheDir,
            options.timeoutMs,
            allowPrivate,
          )
        : undefined;

      const entry: EnrichedUrlMeta = {
        url,
        status: 'ok',
        fetchedAt,
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(safeOgImage ? { ogImage: safeOgImage } : {}),
        ...(parsed.keywords.length > 0 ? { keywords: parsed.keywords } : {}),
        ...(faviconRelPath ? { faviconRelPath } : {}),
      };
      cache.entries[url] = entry;
      metadata.set(url, entry);
      stats.fetchedOk++;
    } catch {
      const entry: EnrichedUrlMeta = { url, status: 'error', fetchedAt };
      cache.entries[url] = entry;
      metadata.set(url, entry);
      stats.failed++;
    }
  });

  if (toFetch.length > 0) {
    await saveCacheAtomic(cacheFile, cache);
  }

  return { metadata, stats };
}
