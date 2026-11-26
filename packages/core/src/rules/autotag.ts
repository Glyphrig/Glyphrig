import type { AutoTagRule, BookmarkEntry } from '../types.js';

function sanitizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchAutoTagPattern(rawUrl: string, rawPattern: string): boolean {
  const pattern = rawPattern.trim();
  if (!pattern) return false;

  // Regex pattern syntax: /pattern/flags
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1) || 'i';
    try {
      return new RegExp(body, flags).test(rawUrl);
    } catch {
      return false;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const actualPath = parsed.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  const hostAndPath = actualPath ? `${host}/${actualPath}` : host;
  const cleanPattern = pattern
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  // Host-only rule (no '/' in pattern)
  if (!cleanPattern.includes('/')) {
    if (cleanPattern.startsWith('*.')) {
      const suffix = cleanPattern.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    if (cleanPattern.includes('*')) {
      return globToRegExp(cleanPattern).test(host);
    }
    return host === cleanPattern || host.endsWith(`.${cleanPattern}`);
  }

  // Host + path glob rule
  const [patternHost, ...pathParts] = cleanPattern.split('/');
  const patternPath = pathParts.join('/');

  const hostMatched = patternHost
    ? patternHost.startsWith('*.')
      ? host === patternHost.slice(2) || host.endsWith(`.${patternHost.slice(2)}`)
      : patternHost.includes('*')
        ? globToRegExp(patternHost).test(host)
        : host === patternHost || host.endsWith(`.${patternHost}`)
    : false;

  if (!hostMatched) return false;
  if (!patternPath) return true;

  if (patternPath === '**') {
    return true;
  }
  if (patternPath.includes('*')) {
    return globToRegExp(patternPath).test(actualPath);
  }
  return (
    hostAndPath === cleanPattern ||
    actualPath === patternPath ||
    actualPath.startsWith(`${patternPath}/`)
  );
}

export function applyAutoTagRules(
  entry: Pick<BookmarkEntry, 'url' | 'tags'>,
  rules: AutoTagRule[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const existing of entry.tags) {
    const clean = sanitizeTag(existing);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }

  if (!rules || rules.length === 0) {
    return out;
  }

  for (const rule of rules) {
    if (!rule.match || !Array.isArray(rule.tags) || rule.tags.length === 0) {
      continue;
    }
    if (!matchAutoTagPattern(entry.url, rule.match)) {
      continue;
    }
    for (const rawTag of rule.tags) {
      const clean = sanitizeTag(rawTag);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }

  return out;
}
