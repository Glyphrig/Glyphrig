const rawBasePath = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
export const BASE_PATH = rawBasePath
  ? rawBasePath.startsWith('/')
    ? rawBasePath
    : `/${rawBasePath}`
  : '';

export function withBasePath(pathname: string): string {
  if (!pathname) return BASE_PATH || '/';
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${BASE_PATH}${normalized}`;
}

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'https://glyphrig.github.io/Glyphrig'
).replace(/\/+$/, '');

export const REPO_URL = 'https://github.com/Glyphrig/Glyphrig';
export const RELEASES_URL = 'https://github.com/Glyphrig/Glyphrig/releases';
export const ISSUES_URL = 'https://github.com/Glyphrig/Glyphrig/issues';
export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/glyphrig/ennpigbnodfiobgblonmckfeonnagjeg';
export const SPONSOR_URL = 'https://tekromancy.com/';
export const SPONSOR_NAME = 'Tekromancy';

export interface DocEntry {
  slug: string;
  filename: string;
  title: string;
  summary: string;
  badge: string;
}

export const DOC_ENTRIES: DocEntry[] = [
  {
    slug: 'getting-started',
    filename: 'GETTING_STARTED.md',
    title: 'Getting Started',
    summary:
      'Scaffold a data-only bookmark repository, wire CI/CD, and connect Desktop Chrome, Firefox, Firefox Android, and mobile PWA.',
    badge: 'Guide',
  },
  {
    slug: 'theming',
    filename: 'THEMING.md',
    title: 'Theming & Customization',
    summary:
      'Use built-in presets (editorial, minimal, terminal, nord), CSS overrides, reusable theme directories, or custom Astro layouts.',
    badge: 'Customization',
  },
  {
    slug: 'architecture',
    filename: 'ARCHITECTURE.md',
    title: 'Architecture Specification',
    summary:
      'How @glyphrig/core, round-trip Markdown serialization, URL safety rails, 3-way merge, and @glyphrig/site work together.',
    badge: 'Reference',
  },
  {
    slug: 'github-oauth-setup',
    filename: 'GITHUB_OAUTH_SETUP.md',
    title: 'GitHub OAuth Device Flow',
    summary:
      'Register a GitHub OAuth App with Device Flow enabled for one-click browser sign-in without backend servers or client secrets.',
    badge: 'Auth',
  },
];
