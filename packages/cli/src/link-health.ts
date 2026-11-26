import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inspectUrlSafety,
  mapWithConcurrency,
  parseBookmarkRepoFiles,
  serializeFolderMarkdown,
  type FolderNode,
} from '@glyphrig/core';
import { readBookmarkDirectory } from './loader.js';

const USER_AGENT = 'GlyphrigLinkChecker/0.5 (+https://github.com/Glyphrig/Glyphrig)';
const LINK_HEALTH_FILE = 'link-health.json';

export interface LinkHealthRecord {
  url: string;
  status: 'ok' | 'dead' | 'unknown';
  httpStatus?: number;
  error?: string;
  waybackUrl?: string;
  checkedAt: string;
}

export interface LinkHealthCache {
  version: 1;
  checkedAt: string;
  entries: Record<string, LinkHealthRecord>;
}

function normalizeWaybackUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('-->')) return undefined;
  try {
    const parsed = new URL(trimmed.replace(/^http:\/\//i, 'https://'));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'web.archive.org') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export async function loadLinkHealthCache(
  cacheDir: string,
): Promise<Map<string, LinkHealthRecord>> {
  const map = new Map<string, LinkHealthRecord>();
  try {
    const raw = await fs.readFile(path.join(cacheDir, LINK_HEALTH_FILE), 'utf8');
    const parsed = JSON.parse(raw) as LinkHealthCache;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') {
      for (const [url, rec] of Object.entries(parsed.entries)) {
        map.set(url, rec);
      }
    }
  } catch {
    // Missing or unreadable cache is fine
  }
  return map;
}

async function saveLinkHealthCacheAtomic(
  cacheDir: string,
  entries: Map<string, LinkHealthRecord>,
): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, LINK_HEALTH_FILE);
  const tmpFile = `${target}.${process.pid}.tmp`;
  const payload: LinkHealthCache = {
    version: 1,
    checkedAt: new Date().toISOString(),
    entries: Object.fromEntries(entries.entries()),
  };
  await fs.writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmpFile, target);
}

export async function lookupWaybackSnapshot(
  url: string,
  timeoutMs = 6000,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string | undefined> {
  try {
    const res = await fetchFn(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    const data = (await res.json()) as {
      archived_snapshots?: {
        closest?: { available?: boolean; url?: string };
      };
    };
    const closest = data.archived_snapshots?.closest;
    if (closest?.available && closest.url) {
      return normalizeWaybackUrl(closest.url);
    }
  } catch {
    // Ignore Wayback lookup errors
  }
  return undefined;
}

export async function submitToWayback(
  url: string,
  timeoutMs = 12000,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string | undefined> {
  try {
    const res = await fetchFn(`https://web.archive.org/save/${url}`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = res.ok;
    const location = res.headers.get('content-location');
    const finalResUrl = res.url;
    await res.body?.cancel().catch(() => {});
    if (!ok) return undefined;
    if (location) {
      const candidate = location.startsWith('http')
        ? location
        : `https://web.archive.org${location.startsWith('/') ? '' : '/'}${location}`;
      return normalizeWaybackUrl(candidate);
    }
    if (finalResUrl && finalResUrl.includes('web.archive.org/web/')) {
      return normalizeWaybackUrl(finalResUrl);
    }
  } catch {
    // Ignore Save Page Now errors
  }
  return undefined;
}

function classifyHttpStatus(status: number): 'ok' | 'dead' | 'unknown' {
  // 2xx, 3xx, auth/bot/range responses indicate the target still exists
  if (status >= 200 && status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 405 || status === 416 || status === 429) {
    return 'ok';
  }
  if (status === 404 || status === 410) {
    return 'dead';
  }
  if (status >= 500) {
    return 'unknown';
  }
  return 'dead';
}

function isSafeCheckTarget(url: string, allowPrivate: boolean): boolean {
  if (allowPrivate) {
    try {
      const p = new URL(url);
      return p.protocol === 'http:' || p.protocol === 'https:';
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

async function safeRequestStatus(
  startUrl: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string>,
  timeoutMs: number,
  allowPrivate: boolean,
  fetchFn: typeof fetch,
  maxRedirects = 5,
): Promise<{ status: number } | { blocked: true }> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafeCheckTarget(currentUrl, allowPrivate)) {
      return { blocked: true };
    }
    const res = await fetchFn(currentUrl, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = res.status;
    const loc = res.headers.get('location');
    await res.body?.cancel().catch(() => {});

    if (status >= 300 && status < 400 && loc) {
      if (hop === maxRedirects) {
        return { status };
      }
      try {
        currentUrl = new URL(loc, currentUrl).toString();
      } catch {
        return { blocked: true };
      }
      continue;
    }
    return { status };
  }
  return { blocked: true };
}

export interface CheckLinksOptions {
  inputDir: string;
  cacheDir?: string;
  concurrency?: number;
  timeoutMs?: number;
  lookupWayback?: boolean;
  submitWayback?: boolean;
  writeArchives?: boolean;
  allowPrivateUrlsForTest?: boolean;
  fetchFn?: typeof fetch;
}

export interface CheckLinksReport {
  checked: number;
  ok: number;
  dead: number;
  unknown: number;
  skippedUnsafe: number;
  waybackFound: number;
  filesUpdated: string[];
  results: LinkHealthRecord[];
}

export async function checkBookmarkLinks(
  options: CheckLinksOptions,
): Promise<CheckLinksReport> {
  const inputDir = path.resolve(options.inputDir);
  const cacheDir = path.resolve(options.cacheDir ?? '.glyphrig-cache');
  const concurrency = Math.max(1, Math.min(20, options.concurrency ?? 8));
  const timeoutMs = options.timeoutMs ?? 6000;
  const lookupWayback = options.lookupWayback ?? true;
  const submitWayback = options.submitWayback ?? false;
  const allowPrivate = options.allowPrivateUrlsForTest ?? false;
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  const files = await readBookmarkDirectory(inputDir);
  const parsed = parseBookmarkRepoFiles(files, 'bookmarks');

  const uniqueUrls = new Set<string>();
  const existingArchiveByUrl = new Map<string, string>();

  function walk(folder: FolderNode): void {
    for (const bm of folder.bookmarks) {
      uniqueUrls.add(bm.url);
      if (bm.archiveUrl) {
        existingArchiveByUrl.set(bm.url, bm.archiveUrl);
      }
    }
    for (const child of folder.children) {
      walk(child);
    }
  }
  walk(parsed.tree.root);

  const cache = await loadLinkHealthCache(cacheDir);
  let skippedUnsafe = 0;
  const allowedUrls: string[] = [];

  for (const url of uniqueUrls) {
    if (!isSafeCheckTarget(url, allowPrivate)) {
      skippedUnsafe++;
      continue;
    }
    allowedUrls.push(url);
  }

  const results = await mapWithConcurrency(allowedUrls, concurrency, async (url) => {
    const checkedAt = new Date().toISOString();
    let status: 'ok' | 'dead' | 'unknown' = 'unknown';
    let httpStatus: number | undefined;
    let errorMsg: string | undefined;

    try {
      let outcome = await safeRequestStatus(
        url,
        'HEAD',
        { 'User-Agent': USER_AGENT },
        timeoutMs,
        allowPrivate,
        fetchFn,
      );
      if ('blocked' in outcome) {
        status = 'unknown';
        errorMsg = 'Redirect target blocked by safety rails';
      } else {
        if (
          outcome.status === 400 ||
          outcome.status === 403 ||
          outcome.status === 405 ||
          outcome.status === 501
        ) {
          const getOutcome = await safeRequestStatus(
            url,
            'GET',
            { 'User-Agent': USER_AGENT, Range: 'bytes=0-1024' },
            timeoutMs,
            allowPrivate,
            fetchFn,
          );
          if (!('blocked' in getOutcome)) {
            outcome = getOutcome;
          }
        }
        httpStatus = outcome.status;
        status = classifyHttpStatus(outcome.status);
      }
    } catch (err) {
      status = 'unknown';
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    let waybackUrl = existingArchiveByUrl.get(url) ?? cache.get(url)?.waybackUrl;
    if (status === 'dead' && lookupWayback && !waybackUrl) {
      waybackUrl = await lookupWaybackSnapshot(url, timeoutMs, fetchFn);
    } else if (status === 'ok' && submitWayback && !waybackUrl) {
      waybackUrl = await submitToWayback(url, Math.max(timeoutMs, 10000), fetchFn);
    }

    const record: LinkHealthRecord = {
      url,
      status,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errorMsg ? { error: errorMsg } : {}),
      ...(waybackUrl ? { waybackUrl } : {}),
      checkedAt,
    };
    cache.set(url, record);
    return record;
  });

  await saveLinkHealthCacheAtomic(cacheDir, cache);

  const filesUpdated: string[] = [];
  if (options.writeArchives) {
    const modifiedFolders: FolderNode[] = [];
    function applyArchives(folder: FolderNode): void {
      let dirty = false;
      for (const bm of folder.bookmarks) {
        const rec = cache.get(bm.url);
        if (rec?.waybackUrl && !bm.archiveUrl) {
          bm.archiveUrl = rec.waybackUrl;
          dirty = true;
        }
      }
      if (dirty) {
        modifiedFolders.push(folder);
      }
      for (const child of folder.children) {
        applyArchives(child);
      }
    }
    applyArchives(parsed.tree.root);

    for (const folder of modifiedFolders) {
      const repoFilePath = folder.path
        ? `bookmarks/${folder.path}/README.md`
        : 'bookmarks/README.md';
      const content = serializeFolderMarkdown(folder, parsed.rawDocs.get(folder.path));
      if (files.get(repoFilePath) === content) continue;
      const relInside = repoFilePath.replace(/^bookmarks\/?/, '');
      const destAbs = path.join(inputDir, relInside);
      await fs.writeFile(destAbs, content, 'utf8');
      filesUpdated.push(destAbs);
    }
  }

  return {
    checked: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    dead: results.filter((r) => r.status === 'dead').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
    skippedUnsafe,
    waybackFound: results.filter((r) => Boolean(r.waybackUrl)).length,
    filesUpdated,
    results,
  };
}
