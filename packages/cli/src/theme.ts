import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  SITE_ROOT,
  type ColorSchemePreference,
  type ThemeMode,
} from '@glyphrig/site';
import YAML from 'yaml';
import { z } from 'zod';

export interface BuiltinThemePresetInfo {
  id: string;
  name: string;
  description: string;
  defaultAccent: string;
  defaultColorScheme: ColorSchemePreference;
  defaultView: 'list' | 'cards';
  css: string;
}

const MINIMAL_THEME_CSS = `/* Glyphrig Built-in Preset: Minimal */
:root {
  --bg: #ffffff;
  --surface: #fafafa;
  --surface-muted: #f3f4f6;
  --ink: #111827;
  --ink-muted: #6b7280;
  --border: #e5e7eb;
  --accent: #2563eb;
  --accent-soft: color-mix(in srgb, var(--accent) 10%, transparent);
  --font-serif: var(--font-sans);
  --radius: 4px;
}

html[data-theme='dark'] {
  --bg: #0a0a0a;
  --surface: #121212;
  --surface-muted: #1c1c1c;
  --ink: #f3f4f6;
  --ink-muted: #9ca3af;
  --border: #262626;
  --accent: #60a5fa;
  --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
}

.brand-title,
.page-title,
.section-heading {
  letter-spacing: -0.025em;
}
`;

const TERMINAL_THEME_CSS = `/* Glyphrig Built-in Preset: Terminal */
:root {
  --bg: #f4f7f4;
  --surface: #ffffff;
  --surface-muted: #e6efe7;
  --ink: #0f1f14;
  --ink-muted: #3f5c47;
  --border: #c5d9c9;
  --accent: #15803d;
  --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
  --font-serif: var(--font-mono);
  --font-sans: var(--font-mono);
  --radius: 2px;
}

html[data-theme='dark'] {
  --bg: #090d0a;
  --surface: #0f1611;
  --surface-muted: #16221a;
  --ink: #d7f5dc;
  --ink-muted: #7aa884;
  --border: #213829;
  --accent: #22c55e;
  --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
}

body {
  font-size: 14.5px;
}

.page-title::before {
  content: '> ';
  color: var(--accent);
}
`;

const NORD_THEME_CSS = `/* Glyphrig Built-in Preset: Nord */
:root {
  --bg: #eceff4;
  --surface: #f8fafc;
  --surface-muted: #e5e9f0;
  --ink: #2e3440;
  --ink-muted: #4c566a;
  --border: #d8dee9;
  --accent: #5e81ac;
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --radius: 10px;
}

html[data-theme='dark'] {
  --bg: #2e3440;
  --surface: #3b4252;
  --surface-muted: #434c5e;
  --ink: #eceff4;
  --ink-muted: #d8dee9;
  --border: #4c566a;
  --accent: #88c0d0;
  --accent-soft: color-mix(in srgb, var(--accent) 18%, transparent);
}
`;

export const BUILTIN_THEMES: readonly BuiltinThemePresetInfo[] = [
  {
    id: 'editorial',
    name: 'Editorial Digital Garden',
    description: 'Warm paper light & charcoal dark palette with serif display typography (default).',
    defaultAccent: '#b45309',
    defaultColorScheme: 'system',
    defaultView: 'list',
    css: '',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Crisp monochrome layout with geometric sans-serif headings and hairline borders.',
    defaultAccent: '#2563eb',
    defaultColorScheme: 'system',
    defaultView: 'list',
    css: MINIMAL_THEME_CSS,
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Dark-first phosphor monochrome aesthetic with monospace typography and crisp corners.',
    defaultAccent: '#22c55e',
    defaultColorScheme: 'dark',
    defaultView: 'list',
    css: TERMINAL_THEME_CSS,
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Calm Arctic slate-blue palette inspired by Nord for light and dark viewing.',
    defaultAccent: '#5e81ac',
    defaultColorScheme: 'system',
    defaultView: 'list',
    css: NORD_THEME_CSS,
  },
];

const BUILTIN_THEME_MAP = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));

const ThemeManifestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  mode: z.enum(['extend', 'replace', 'astro']).optional(),
  css: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  assetsDir: z.string().min(1).optional(),
  defaults: z
    .object({
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{3,8}$/, 'defaults.accent must be a hex color like #b45309')
        .optional(),
      colorScheme: z.enum(['system', 'light', 'dark']).optional(),
      defaultView: z.enum(['list', 'cards']).optional(),
    })
    .optional(),
});

export interface ResolvedTheme {
  name: string;
  source: 'builtin' | 'css-file' | 'local-dir' | 'package';
  mode: ThemeMode;
  astroRoot: string;
  themeDir?: string;
  cssContent?: string;
  headHtml?: string;
  assetsDir?: string;
  defaults: {
    accent?: string;
    colorScheme?: ColorSchemePreference;
    defaultView?: 'list' | 'cards';
  };
}

async function statOrNull(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

export function applyBasePlaceholder(html: string, base: string): string {
  const clean = base.endsWith('/') ? base : `${base}/`;
  return html.replace(/\{\{\s*base\s*\}\}/g, clean);
}

async function loadThemeManifest(themeDir: string): Promise<z.infer<typeof ThemeManifestSchema>> {
  const candidates = ['theme.yaml', 'theme.yml', 'theme.json'];
  for (const fileName of candidates) {
    const filePath = path.join(themeDir, fileName);
    const st = await statOrNull(filePath);
    if (!st?.isFile()) continue;
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = fileName.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
    const validated = ThemeManifestSchema.safeParse(parsed ?? {});
    if (!validated.success) {
      const details = validated.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid theme manifest ${filePath}: ${details}`);
    }
    return validated.data;
  }
  return {};
}

async function loadThemeFromDirectory(
  themeDir: string,
  source: 'local-dir' | 'package',
  fallbackName?: string,
): Promise<ResolvedTheme> {
  const manifest = await loadThemeManifest(themeDir);
  const pagesDirStat = await statOrNull(path.join(themeDir, 'src', 'pages'));
  const hasAstroPages = Boolean(pagesDirStat?.isDirectory());

  const mode: ThemeMode = manifest.mode ?? (hasAstroPages ? 'astro' : 'extend');
  if (mode === 'astro' && !hasAstroPages) {
    throw new Error(
      `Theme at ${themeDir} specifies mode "astro", but has no src/pages/ directory.`,
    );
  }

function resolveContainedThemePath(themeDir: string, relPath: string, fieldName: string): string {
  const root = path.resolve(themeDir);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Theme manifest "${fieldName}" escapes theme directory: ${relPath}`);
  }
  return resolved;
}

  const cssRel = manifest.css ?? 'theme.css';
  const cssPath = resolveContainedThemePath(themeDir, cssRel, 'css');
  const cssStat = await statOrNull(cssPath);
  let cssContent: string | undefined;
  if (cssStat?.isFile()) {
    cssContent = await fs.readFile(cssPath, 'utf8');
  } else if (manifest.css) {
    throw new Error(`Theme stylesheet declared in manifest not found: ${cssPath}`);
  } else if (mode !== 'astro') {
    throw new Error(
      `Theme directory ${themeDir} must contain either "${cssRel}" (for a CSS theme) or "src/pages/" (for a full Astro theme).`,
    );
  }

  const headRel = manifest.head ?? 'head.html';
  const headPath = resolveContainedThemePath(themeDir, headRel, 'head');
  const headStat = await statOrNull(headPath);
  let headHtml: string | undefined;
  if (headStat?.isFile()) {
    headHtml = await fs.readFile(headPath, 'utf8');
  } else if (manifest.head) {
    throw new Error(`Theme head snippet declared in manifest not found: ${headPath}`);
  }

  const assetsRel = manifest.assetsDir ?? 'assets';
  const assetsPath = resolveContainedThemePath(themeDir, assetsRel, 'assetsDir');
  const assetsStat = await statOrNull(assetsPath);
  const assetsDir = assetsStat?.isDirectory() ? assetsPath : undefined;

  const themeName =
    manifest.name?.trim() || fallbackName || path.basename(themeDir) || 'custom';

  return {
    name: themeName,
    source,
    mode,
    astroRoot: mode === 'astro' ? themeDir : SITE_ROOT,
    themeDir,
    ...(cssContent !== undefined ? { cssContent } : {}),
    ...(headHtml !== undefined ? { headHtml } : {}),
    ...(assetsDir !== undefined ? { assetsDir } : {}),
    defaults: {
      ...(manifest.defaults?.accent ? { accent: manifest.defaults.accent } : {}),
      ...(manifest.defaults?.colorScheme
        ? { colorScheme: manifest.defaults.colorScheme }
        : {}),
      ...(manifest.defaults?.defaultView
        ? { defaultView: manifest.defaults.defaultView }
        : {}),
    },
  };
}

function tryResolvePackageJson(spec: string, cwd: string): string | null {
  const resolvers = [
    () => createRequire(path.join(cwd, 'package.json')).resolve(`${spec}/package.json`),
    () => createRequire(import.meta.url).resolve(`${spec}/package.json`),
  ];
  for (const resolver of resolvers) {
    try {
      return resolver();
    } catch {
      // Try next resolver
    }
  }
  return null;
}

export async function resolveTheme(
  spec: string | undefined,
  cwd: string,
): Promise<ResolvedTheme> {
  const cleanSpec = (spec ?? '').trim();
  if (!cleanSpec || cleanSpec.toLowerCase() === 'default') {
    const editorial = BUILTIN_THEME_MAP.get('editorial')!;
    return {
      name: editorial.id,
      source: 'builtin',
      mode: 'extend',
      astroRoot: SITE_ROOT,
      defaults: {
        accent: editorial.defaultAccent,
        colorScheme: editorial.defaultColorScheme,
        defaultView: editorial.defaultView,
      },
    };
  }

  const builtin = BUILTIN_THEME_MAP.get(cleanSpec.toLowerCase());
  if (builtin) {
    return {
      name: builtin.id,
      source: 'builtin',
      mode: 'extend',
      astroRoot: SITE_ROOT,
      ...(builtin.css ? { cssContent: builtin.css } : {}),
      defaults: {
        accent: builtin.defaultAccent,
        colorScheme: builtin.defaultColorScheme,
        defaultView: builtin.defaultView,
      },
    };
  }

  const looksLikePath =
    cleanSpec.startsWith('.') ||
    cleanSpec.startsWith('/') ||
    path.isAbsolute(cleanSpec) ||
    cleanSpec.endsWith('.css');
  const candidatePath = path.resolve(cwd, cleanSpec);
  const candidateStat = await statOrNull(candidatePath);

  if (candidateStat?.isFile()) {
    const cssContent = await fs.readFile(candidatePath, 'utf8');
    return {
      name: path.basename(candidatePath, path.extname(candidatePath)) || 'custom',
      source: 'css-file',
      mode: 'extend',
      astroRoot: SITE_ROOT,
      cssContent,
      defaults: {},
    };
  }

  if (candidateStat?.isDirectory()) {
    return loadThemeFromDirectory(candidatePath, 'local-dir');
  }

  if (looksLikePath) {
    throw new Error(`Theme path not found: ${candidatePath}`);
  }

  // Try npm package resolution
  const pkgJsonPath = tryResolvePackageJson(cleanSpec, cwd);
  if (pkgJsonPath) {
    const pkgDir = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as {
      name?: string;
      glyphrigTheme?: string | { dir?: string };
    };
    const subDir =
      typeof pkg.glyphrigTheme === 'string'
        ? pkg.glyphrigTheme
        : typeof pkg.glyphrigTheme?.dir === 'string'
          ? pkg.glyphrigTheme.dir
          : '.';
    const resolvedDir = path.resolve(pkgDir, subDir);
    return loadThemeFromDirectory(resolvedDir, 'package', pkg.name || cleanSpec);
  }

  const presetNames = BUILTIN_THEMES.map((t) => t.id).join(', ');
  throw new Error(
    `Theme "${cleanSpec}" could not be resolved. Use a built-in preset (${presetNames}), a local directory/CSS path (e.g. "./theme"), or an installed npm theme package.`,
  );
}

export interface ScaffoldThemeOptions {
  targetDir: string;
  type?: 'css' | 'astro';
  mode?: 'extend' | 'replace';
  name?: string;
  force?: boolean;
}

export interface ScaffoldThemeResult {
  targetDir: string;
  type: 'css' | 'astro';
  created: string[];
  skipped: string[];
}

function buildCssThemeTemplate(name: string, mode: 'extend' | 'replace'): Map<string, string> {
  const files = new Map<string, string>();
  files.set(
    'theme.yaml',
    YAML.stringify({
      name,
      description: 'Custom Glyphrig CSS theme',
      version: '1.0.0',
      mode,
      defaults: {
        accent: '#0f766e',
        colorScheme: 'system',
        defaultView: 'list',
      },
    }),
  );

  files.set(
    'theme.css',
    `/* ${name} — Custom Glyphrig Theme
 * Override any of Glyphrig's CSS custom properties or component classes below.
 * Place local fonts/images inside ./assets/ and reference them from head.html
 * using {{base}}theme-assets/<file> so subpath deployments work automatically.
 */

:root {
  --bg: #f8faf9;
  --surface: #ffffff;
  --surface-muted: #edf2f0;
  --ink: #13201c;
  --ink-muted: #4b615a;
  --border: #d5e2dd;
  --accent: #0f766e;
  --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
  --font-serif: Georgia, 'Iowan Old Style', serif;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --radius: 10px;
  --sidebar-width: 270px;
}

html[data-theme='dark'] {
  --bg: #0c1412;
  --surface: #131e1b;
  --surface-muted: #1b2925;
  --ink: #e8f3ef;
  --ink-muted: #8ea9a0;
  --border: #253832;
  --accent: #2dd4bf;
  --accent-soft: color-mix(in srgb, var(--accent) 18%, transparent);
}
`,
  );

  files.set(
    'head.html',
    `<!-- Optional HTML injected into <head> on every page (e.g. web fonts or custom meta tags).
     Use {{base}} for subpath-safe URLs into your theme's assets/ folder, e.g.:
     <link rel="stylesheet" href="{{base}}theme-assets/fonts.css" />
-->
`,
  );

  return files;
}

function buildAstroThemeTemplate(name: string): Map<string, string> {
  const files = new Map<string, string>();
  files.set(
    'theme.yaml',
    YAML.stringify({
      name,
      description: 'Custom Astro theme for Glyphrig',
      version: '1.0.0',
      mode: 'astro',
      defaults: {
        accent: '#b45309',
        colorScheme: 'system',
        defaultView: 'list',
      },
    }),
  );

  files.set(
    'src/env.d.ts',
    `/// <reference types="astro/client" />

declare module 'virtual:glyphrig-data' {
  import type { GlyphrigSiteData } from '@glyphrig/site';
  export const siteData: GlyphrigSiteData;
}

declare module 'virtual:glyphrig-helpers' {
  import type { EnrichedBookmark, EnrichedFolderNode } from '@glyphrig/site';
  export function normalizeBase(base: string): string;
  export function withBase(path: string): string;
  export function folderHref(folderPath: string): string;
  export function tagHref(tagSlug: string): string;
  export function contributorHref(userSlug: string): string;
  export function findFolderByPath(folderPath: string): EnrichedFolderNode | undefined;
  export function getFolderBreadcrumbs(folder: EnrichedFolderNode): Array<{ title: string; href: string }>;
  export function collectTagsInBookmarks(bookmarks: EnrichedBookmark[]): Array<{ tag: string; slug: string; count: number }>;
  export function escapeXml(str: string): string;
  export function sortRecentBookmarks(bookmarks: EnrichedBookmark[]): EnrichedBookmark[];
  export function deduplicateBookmarksByUrl(bookmarks: EnrichedBookmark[]): EnrichedBookmark[];
  export function sortPopularBookmarks(bookmarks: EnrichedBookmark[]): EnrichedBookmark[];
}
`,
  );

  files.set(
    'src/styles/theme.css',
    `:root {
  --bg: #fafaf9;
  --surface: #ffffff;
  --ink: #1c1917;
  --ink-muted: #57534e;
  --border: #e7e5e4;
  --accent: #b45309;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111317;
    --surface: #181c23;
    --ink: #f5f5f4;
    --ink-muted: #a8a29e;
    --border: #2a303c;
  }
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.6;
}

.wrap {
  max-width: 820px;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
}

.site-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 1rem 0 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}

.site-nav a {
  color: var(--ink-muted);
  text-decoration: none;
}

.site-nav a:hover {
  color: var(--accent);
}

.bm-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.75rem;
}

.bm-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.9rem 1rem;
}

.bm-card a {
  color: var(--ink);
  font-weight: 600;
  text-decoration: none;
}

.bm-card a:hover {
  color: var(--accent);
}

.bm-meta {
  font-size: 0.85rem;
  color: var(--ink-muted);
  margin-top: 0.25rem;
}
`,
  );

  files.set(
    'src/pages/index.astro',
    `---
import '../styles/theme.css';
import { siteData } from 'virtual:glyphrig-data';
import { folderHref, withBase } from 'virtual:glyphrig-helpers';
---

<!doctype html>
<html lang="en" data-theme-name={siteData.themeName}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{siteData.config.site.title}</title>
    <meta name="description" content={siteData.config.site.description} />
    {siteData.customHeadContent && <Fragment set:html={siteData.customHeadContent} />}
    {siteData.customCssContent && <style set:html={siteData.customCssContent} />}
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>{siteData.config.site.title}</h1>
        <p>{siteData.config.site.description}</p>
        <nav class="site-nav" aria-label="Folders">
          <a href={withBase('')}>All ({siteData.allBookmarks.length})</a>
          {siteData.flatFolders.map((folder) => (
            <a href={folderHref(folder.path)}>
              {folder.title} ({folder.totalBookmarkCount})
            </a>
          ))}
        </nav>
      </header>
      <main data-pagefind-body>
        <ul class="bm-list">
          {siteData.allBookmarks.map((bm) => (
            <li class="bm-card">
              <a href={bm.url} target="_blank" rel="noopener noreferrer">{bm.title}</a>
              <div class="bm-meta">
                {bm.domain}
                {bm.effectiveDescription ? \` — \${bm.effectiveDescription}\` : ''}
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  </body>
</html>
`,
  );

  files.set(
    'src/pages/f/[...folder].astro',
    `---
import '../../styles/theme.css';
import { siteData } from 'virtual:glyphrig-data';
import { folderHref, withBase } from 'virtual:glyphrig-helpers';
import type { EnrichedFolderNode } from '@glyphrig/site';

export function getStaticPaths() {
  return siteData.flatFolders.map((folder) => ({
    params: { folder: folder.path },
    props: { folder },
  }));
}

interface Props {
  folder: EnrichedFolderNode;
}

const { folder } = Astro.props;
---

<!doctype html>
<html lang="en" data-theme-name={siteData.themeName}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{folder.title} — {siteData.config.site.title}</title>
    {siteData.customHeadContent && <Fragment set:html={siteData.customHeadContent} />}
    {siteData.customCssContent && <style set:html={siteData.customCssContent} />}
  </head>
  <body>
    <div class="wrap">
      <header>
        <p><a href={withBase('')}>← {siteData.config.site.title}</a></p>
        <h1>{folder.title}</h1>
        {folder.children.length > 0 && (
          <nav class="site-nav" aria-label="Subfolders">
            {folder.children.map((child) => (
              <a href={folderHref(child.path)}>{child.title}</a>
            ))}
          </nav>
        )}
      </header>
      <main data-pagefind-body>
        <ul class="bm-list">
          {folder.bookmarks.map((bm) => (
            <li class="bm-card">
              <a href={bm.url} target="_blank" rel="noopener noreferrer">{bm.title}</a>
              <div class="bm-meta">
                {bm.domain}
                {bm.effectiveDescription ? \` — \${bm.effectiveDescription}\` : ''}
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  </body>
</html>
`,
  );

  files.set(
    'src/pages/rss.xml.ts',
    `import type { APIRoute } from 'astro';
import { siteData } from 'virtual:glyphrig-data';
import { escapeXml, sortRecentBookmarks, withBase } from 'virtual:glyphrig-helpers';

export const GET: APIRoute = () => {
  const origin = (siteData.config.site.url ?? '').replace(/\\/+$/, '');
  const siteLink = origin ? \`\${origin}\${withBase('')}\` : withBase('');
  const items = sortRecentBookmarks(siteData.allBookmarks)
    .slice(0, 50)
    .map(
      (bm) =>
        \`<item><title>\${escapeXml(bm.title)}</title><link>\${escapeXml(bm.url)}</link></item>\`,
    )
    .join('');

  const xml = \`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>\${escapeXml(siteData.config.site.title)}</title><link>\${escapeXml(siteLink)}</link><description>\${escapeXml(siteData.config.site.description)}</description>\${items}</channel></rss>\`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
`,
  );

  return files;
}

async function writeScaffoldFiles(
  targetDir: string,
  files: Map<string, string>,
  force: boolean,
): Promise<{ created: string[]; skipped: string[] }> {
  await fs.mkdir(targetDir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];

  for (const [relPath, content] of files.entries()) {
    const absPath = path.join(targetDir, relPath);
    const existing = await statOrNull(absPath);
    if (existing && !force) {
      skipped.push(relPath);
      continue;
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
    created.push(relPath);
  }
  return { created, skipped };
}

export async function scaffoldTheme(
  options: ScaffoldThemeOptions,
): Promise<ScaffoldThemeResult> {
  const targetDir = path.resolve(options.targetDir);
  const type = options.type ?? 'css';
  const mode = options.mode ?? 'extend';
  const name = options.name?.trim() || path.basename(targetDir) || 'custom-theme';
  const files =
    type === 'astro'
      ? buildAstroThemeTemplate(name)
      : buildCssThemeTemplate(name, mode);
  const { created, skipped } = await writeScaffoldFiles(
    targetDir,
    files,
    Boolean(options.force),
  );
  return { targetDir, type, created, skipped };
}

export async function ejectDefaultTheme(options: {
  targetDir: string;
  name?: string;
  force?: boolean;
}): Promise<ScaffoldThemeResult> {
  const targetDir = path.resolve(options.targetDir);
  const name = options.name?.trim() || path.basename(targetDir) || 'custom-theme';
  const force = Boolean(options.force);
  const files = new Map<string, string>();

  files.set(
    'theme.yaml',
    YAML.stringify({
      name,
      description: 'Ejected copy of the default Glyphrig Astro theme',
      version: '1.0.0',
      mode: 'astro',
      defaults: {
        accent: '#b45309',
        colorScheme: 'system',
        defaultView: 'list',
      },
    }),
  );

  const siteSrcDir = path.join(SITE_ROOT, 'src');
  async function walkSrc(dir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkSrc(abs, rel);
      } else if (entry.isFile()) {
        // Skip package entrypoint `index.ts` (only needed for `@glyphrig/site` npm export)
        if (rel === 'index.ts') continue;
        files.set(`src/${rel}`, await fs.readFile(abs, 'utf8'));
      }
    }
  }
  await walkSrc(siteSrcDir, '');

  const { created, skipped } = await writeScaffoldFiles(targetDir, files, force);
  return { targetDir, type: 'astro', created, skipped };
}
