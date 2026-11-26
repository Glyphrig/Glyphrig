import type {
  BookmarkEntry,
  BookmarkTree,
  CleanedUrlRecord,
  FolderNode,
  SafetyConfig,
  SkippedUrlReason,
  SkippedUrlRecord,
} from '../types.js';
import { DEFAULT_SAFETY_CONFIG } from '../types.js';
import { normalizeUrl, stripTrackingParams } from './sanitize.js';

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'api_key',
  'apikey',
  'api-key',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'jwt',
  'auth',
  'auth_token',
  'session',
  'session_id',
  'sessionid',
  'sid',
  'private_key',
  'x-amz-security-token',
  'x-amz-signature',
  'sig',
  'signature',
]);

const PRIVATE_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.localdomain',
];

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) {
    return false;
  }
  if (bare === '::1' || bare === '::' || bare === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // IPv4-mapped IPv6 ::ffff:127.0.0.1
  if (bare.startsWith('::ffff:')) {
    const v4Part = bare.slice('::ffff:'.length);
    const parsed = parseIpv4(v4Part);
    if (parsed) {
      return isPrivateIpv4(parsed);
    }
    // Hex-encoded IPv4 in URL normalization e.g. ::ffff:7f00:1
    const hexParts = v4Part.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0] ?? '', 16);
      const lo = Number.parseInt(hexParts[1] ?? '', 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const octets: [number, number, number, number] = [
          (hi >> 8) & 0xff,
          hi & 0xff,
          (lo >> 8) & 0xff,
          lo & 0xff,
        ];
        return isPrivateIpv4(octets);
      }
    }
  }
  // Unique local addresses fc00::/7 (fc.. or fd..)
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) {
    return true;
  }
  // Link-local fe80::/10 (fe80..febf)
  if (/^fe[89ab][0-9a-f]:/.test(bare)) {
    return true;
  }
  return false;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) {
    return true;
  }
  if (host === 'localhost') {
    return true;
  }
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  const v4 = parseIpv4(host);
  if (v4) {
    return isPrivateIpv4(v4);
  }
  if (isPrivateIpv6(host)) {
    return true;
  }
  // Public IPv6 literal (already checked by isPrivateIpv6 above)
  if (host.includes(':')) {
    return false;
  }
  // Single-label hostnames (no dot) like http://intranet/ or http://nas:8080
  if (!host.includes('.')) {
    return true;
  }
  return false;
}

export function isSafeHttpUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    const proto = parsed.protocol.toLowerCase();
    return proto === 'http:' || proto === 'https:';
  } catch {
    return false;
  }
}

export interface UrlSafetyResult {
  allowed: boolean;
  reason?: SkippedUrlReason;
  detail?: string;
  cleanedUrl: string;
  normalizedUrl: string;
  wasCleaned: boolean;
}

export function inspectUrlSafety(
  rawUrl: string,
  config: Partial<SafetyConfig> = {},
): UrlSafetyResult {
  const cfg: SafetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...config };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      allowed: false,
      reason: 'invalid-url',
      detail: 'Malformed URL',
      cleanedUrl: rawUrl,
      normalizedUrl: rawUrl,
      wasCleaned: false,
    };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    if (cfg.filterPrivateUrls) {
      return {
        allowed: false,
        reason: 'non-public-scheme',
        detail: `Disallowed URL scheme "${protocol}"`,
        cleanedUrl: rawUrl,
        normalizedUrl: rawUrl,
        wasCleaned: false,
      };
    }
  }

  if (cfg.filterPrivateUrls && (protocol === 'http:' || protocol === 'https:')) {
    if (isPrivateOrLocalHostname(parsed.hostname)) {
      return {
        allowed: false,
        reason: 'private-host',
        detail: `Private or local host "${parsed.hostname}"`,
        cleanedUrl: rawUrl,
        normalizedUrl: rawUrl,
        wasCleaned: false,
      };
    }
  }

  if (cfg.filterCredentials) {
    if (parsed.username !== '' || parsed.password !== '') {
      return {
        allowed: false,
        reason: 'embedded-credentials',
        detail: 'URL contains embedded username/password credentials',
        cleanedUrl: rawUrl,
        normalizedUrl: rawUrl,
        wasCleaned: false,
      };
    }
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        return {
          allowed: false,
          reason: 'sensitive-query-param',
          detail: `URL contains sensitive query parameter "${key}"`,
          cleanedUrl: rawUrl,
          normalizedUrl: rawUrl,
          wasCleaned: false,
        };
      }
    }
    if (parsed.hash && parsed.hash.includes('=')) {
      const hashBody = parsed.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hashBody);
      for (const key of hashParams.keys()) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
          return {
            allowed: false,
            reason: 'sensitive-query-param',
            detail: `URL fragment contains sensitive parameter "${key}"`,
            cleanedUrl: rawUrl,
            normalizedUrl: rawUrl,
            wasCleaned: false,
          };
        }
      }
    }
  }

  let cleanedUrl = rawUrl.trim();
  let wasCleaned = false;
  if (cfg.stripTrackingParams) {
    const stripped = stripTrackingParams(cleanedUrl, cfg.customStripParams);
    cleanedUrl = stripped.url;
    wasCleaned = stripped.changed;
  }

  return {
    allowed: true,
    cleanedUrl,
    normalizedUrl: normalizeUrl(cleanedUrl, false),
    wasCleaned,
  };
}

export function sanitizeBookmarkTree(
  tree: BookmarkTree,
  config: Partial<SafetyConfig> = {},
): {
  tree: BookmarkTree;
  skipped: SkippedUrlRecord[];
  cleanedUrls: CleanedUrlRecord[];
} {
  const cfg: SafetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...config };
  const skipped: SkippedUrlRecord[] = [];
  const cleanedUrls: CleanedUrlRecord[] = [];

  function walkFolder(folder: FolderNode): FolderNode {
    const nextBookmarks: BookmarkEntry[] = [];
    let order = 0;

    for (const bm of folder.bookmarks) {
      const check = inspectUrlSafety(bm.url, cfg);
      if (!check.allowed) {
        skipped.push({
          url: bm.url,
          title: bm.title,
          folderPath: folder.path,
          reason: check.reason ?? 'invalid-url',
          detail: check.detail ?? 'Unsafe URL',
        });
        continue;
      }

      if (check.wasCleaned) {
        cleanedUrls.push({
          folderPath: folder.path,
          title: bm.title,
          originalUrl: bm.url,
          cleanedUrl: check.cleanedUrl,
        });
      }

      nextBookmarks.push({
        ...bm,
        url: check.cleanedUrl,
        normalizedUrl: check.normalizedUrl,
        order: order++,
      });
    }

    return {
      ...folder,
      bookmarks: nextBookmarks,
      children: folder.children.map(walkFolder),
    };
  }

  return {
    tree: { root: walkFolder(tree.root) },
    skipped,
    cleanedUrls,
  };
}
