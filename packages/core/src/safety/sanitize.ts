const DEFAULT_TRACKING_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'ref_src',
  'yclid',
  'oly_anon_id',
  'oly_enc_id',
  'vero_conv',
  'vero_id',
  'wickedid',
  'twclid',
]);

function isTrackingParam(name: string, extraParams?: string[]): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('utm_')) {
    return true;
  }
  if (DEFAULT_TRACKING_PARAM_NAMES.has(lower)) {
    return true;
  }
  if (extraParams && extraParams.some((p) => p.toLowerCase() === lower)) {
    return true;
  }
  return false;
}

export function stripTrackingParams(
  rawUrl: string,
  extraParams?: string[],
): { url: string; changed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, changed: false };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: rawUrl, changed: false };
  }

  const keys = [...parsed.searchParams.keys()];
  let changed = false;
  for (const key of keys) {
    if (isTrackingParam(key, extraParams)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return { url: rawUrl, changed: false };
  }

  const nextUrl = parsed.toString();
  return { url: nextUrl, changed: nextUrl !== rawUrl };
}

export function normalizeUrl(
  rawUrl: string,
  stripTracking = false,
  extraParams?: string[],
): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  if (stripTracking && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    for (const key of [...parsed.searchParams.keys()]) {
      if (isTrackingParam(key, extraParams)) {
        parsed.searchParams.delete(key);
      }
    }
  }

  // Collapse bare root trailing slash only in normalized comparison key when path is '/'
  // while keeping non-root paths intact.
  const out = parsed.toString();
  if (parsed.pathname === '/' && !parsed.search && !parsed.hash && out.endsWith('/')) {
    return out.slice(0, -1);
  }
  return out;
}
