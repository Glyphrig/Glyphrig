import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseBookmarkRepoFiles } from '@glyphrig/core';
import { SITE_ROOT, type GlyphrigSiteData, type SiteConfig } from '@glyphrig/site';
import { build as astroBuild, dev as astroDev } from 'astro';
import * as pagefind from 'pagefind';
import { loadGlyphrigConfig } from './config.js';
import { enrichBookmarks, type EnrichStats } from './enrich.js';
import { loadLinkHealthCache } from './link-health.js';
import { buildEnrichedSiteTree, readBookmarkDirectory } from './loader.js';
import { generateServiceWorkerScript } from './sw-generator.js';
import { applyBasePlaceholder, resolveTheme, type ResolvedTheme } from './theme.js';

const VIRTUAL_MODULE_ID = 'virtual:glyphrig-data';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_MODULE_ID}`;
const VIRTUAL_THEME_CSS_ID = 'virtual:glyphrig-theme.css';
const RESOLVED_VIRTUAL_THEME_CSS_ID = `\0${VIRTUAL_THEME_CSS_ID}`;
const VIRTUAL_HELPERS_ID = 'virtual:glyphrig-helpers';
const SITE_HELPERS_PATH = path.join(SITE_ROOT, 'src', 'lib', 'data.ts');

const DEFAULT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="#faf8f5"/>
  <rect x="2" y="2" width="60" height="60" rx="12" stroke="#b45309" stroke-width="3"/>
  <path d="M20 14h24a2 2 0 0 1 2 2v34l-14-9-14 9V16a2 2 0 0 1 2-2Z" fill="#b45309"/>
</svg>
`;

export interface BuildSiteOptions {
  cwd?: string;
  inputDir?: string;
  configPath?: string;
  outDir?: string;
  cacheDir?: string;
  base?: string;
  theme?: string;
  noEnrich?: boolean;
  allowPrivateUrlsForTest?: boolean;
}

export interface BuildSiteResult {
  outDir: string;
  bookmarkCount: number;
  folderCount: number;
  enrichStats: EnrichStats;
  config: SiteConfig;
  themeName: string;
}

function guessMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.webp':
      return 'image/webp';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    default:
      return 'application/octet-stream';
  }
}

function safeDecodeUriPath(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function assertSafeOutDir(
  outDir: string,
  protectedPaths: Array<{ label: string; dir: string }>,
): void {
  const resolvedOut = path.resolve(outDir);
  if (resolvedOut === path.parse(resolvedOut).root) {
    throw new Error(`Refusing to clear filesystem root as output directory: ${resolvedOut}`);
  }
  for (const item of protectedPaths) {
    const resolvedTarget = path.resolve(item.dir);
    if (
      resolvedOut === resolvedTarget ||
      resolvedTarget.startsWith(resolvedOut + path.sep)
    ) {
      throw new Error(
        `Refusing to delete "${resolvedOut}" because it overlaps ${item.label} ("${resolvedTarget}"). Choose a dedicated --out directory.`,
      );
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dest);
    }
  }
}

async function prepareSiteData(options: {
  cwd: string;
  inputDir: string;
  configPath?: string;
  cacheDir: string;
  cliBase?: string;
  cliTheme?: string;
  noEnrich?: boolean;
  allowPrivateUrlsForTest?: boolean;
}): Promise<{
  siteData: GlyphrigSiteData;
  enrichStats: EnrichStats;
  resolvedTheme: ResolvedTheme;
  composedThemeCss: string;
}> {
  const { config, themeExplicit } = await loadGlyphrigConfig({
    configPath: options.configPath,
    cwd: options.cwd,
    cliBase: options.cliBase,
    cliTheme: options.cliTheme,
  });

  const resolvedTheme = await resolveTheme(config.theme.use, options.cwd);

  // Apply theme defaults for fields not explicitly configured in glyphrig.config.yaml
  if (!themeExplicit.accent && resolvedTheme.defaults.accent) {
    config.theme.accent = resolvedTheme.defaults.accent;
  }
  if (!themeExplicit.defaultView && resolvedTheme.defaults.defaultView) {
    config.theme.defaultView = resolvedTheme.defaults.defaultView;
  }
  if (!themeExplicit.colorScheme && resolvedTheme.defaults.colorScheme) {
    config.theme.colorScheme = resolvedTheme.defaults.colorScheme;
  }

  const files = await readBookmarkDirectory(options.inputDir);
  const { tree } = parseBookmarkRepoFiles(files, 'bookmarks');

  const urlsToEnrich: string[] = [];
  function collectUrls(folder: typeof tree.root): void {
    for (const bm of folder.bookmarks) urlsToEnrich.push(bm.url);
    for (const child of folder.children) collectUrls(child);
  }
  collectUrls(tree.root);

  const enrichResult = await enrichBookmarks(urlsToEnrich, {
    cacheDir: options.cacheDir,
    enabled: options.noEnrich ? false : config.enrichment.enabled,
    fetchFavicons: config.enrichment.fetchFavicons,
    fetchOgImage: config.enrichment.fetchOgImage,
    autoTags: config.enrichment.autoTags,
    concurrency: config.enrichment.concurrency,
    timeoutMs: config.enrichment.timeoutMs,
    ttlDays: config.enrichment.ttlDays,
    allowPrivateUrlsForTest: options.allowPrivateUrlsForTest,
  });

  const linkHealthByUrl = await loadLinkHealthCache(options.cacheDir);

  const builtTree = buildEnrichedSiteTree(tree, enrichResult.metadata, {
    fetchOgImage: config.enrichment.fetchOgImage,
    autoTags: config.enrichment.autoTags,
    autoTagRules: config.enrichment.autoTagRules,
    linkHealthByUrl,
  });

  let customCssContent: string | undefined;
  if (config.theme.customCss) {
    const cssPath = path.resolve(options.cwd, config.theme.customCss);
    if (!(await exists(cssPath))) {
      throw new Error(`Configured theme.customCss file not found: ${cssPath}`);
    }
    customCssContent = await fs.readFile(cssPath, 'utf8');
  }

  let customHeadContent: string | undefined;
  if (config.theme.customHead) {
    const headPath = path.resolve(options.cwd, config.theme.customHead);
    if (!(await exists(headPath))) {
      throw new Error(`Configured theme.customHead file not found: ${headPath}`);
    }
    customHeadContent = applyBasePlaceholder(
      await fs.readFile(headPath, 'utf8'),
      config.site.base,
    );
  }

  const themeHeadContent = resolvedTheme.headHtml
    ? applyBasePlaceholder(resolvedTheme.headHtml, config.site.base)
    : undefined;

  // Compose the virtual stylesheet in deterministic cascade order:
  // 1. Base stylesheet (unless theme mode is "replace")
  // 2. Active theme stylesheet (preset / theme.css)
  // 3. Explicit theme.accent override from glyphrig.config.yaml
  // 4. User's theme.customCss override
  const cssParts: string[] = [];
  if (resolvedTheme.mode !== 'replace') {
    const activeBaseCssPath = path.join(resolvedTheme.astroRoot, 'src', 'styles', 'theme.css');
    const fallbackBaseCssPath = path.join(SITE_ROOT, 'src', 'styles', 'theme.css');
    if (await exists(activeBaseCssPath)) {
      cssParts.push(await fs.readFile(activeBaseCssPath, 'utf8'));
    } else if (await exists(fallbackBaseCssPath)) {
      cssParts.push(await fs.readFile(fallbackBaseCssPath, 'utf8'));
    }
  }
  if (resolvedTheme.cssContent) {
    cssParts.push(resolvedTheme.cssContent);
  }
  if (themeExplicit.accent) {
    cssParts.push(
      `:root, html[data-theme='dark'], html[data-theme='light'] {\n  --accent: ${config.theme.accent};\n}`,
    );
  }
  if (customCssContent) {
    cssParts.push(customCssContent);
  }
  const composedThemeCss = cssParts.join('\n\n');

  const hasCustomFaviconAsset = await exists(
    path.join(options.cwd, 'assets', 'favicon.svg'),
  );

  const siteData: GlyphrigSiteData = {
    config,
    root: builtTree.root,
    flatFolders: builtTree.flatFolders,
    allBookmarks: builtTree.allBookmarks,
    tags: builtTree.tags,
    contributors: builtTree.contributors,
    themeName: resolvedTheme.name,
    replaceBaseCss: resolvedTheme.mode === 'replace',
    ...(resolvedTheme.cssContent ? { themeCssContent: resolvedTheme.cssContent } : {}),
    ...(themeHeadContent ? { themeHeadContent } : {}),
    ...(customCssContent ? { customCssContent } : {}),
    ...(customHeadContent ? { customHeadContent } : {}),
    hasCustomFaviconAsset,
    generatedAt: new Date().toISOString(),
  };

  return { siteData, enrichStats: enrichResult.stats, resolvedTheme, composedThemeCss };
}

function createVirtualDataPlugin(
  siteData: GlyphrigSiteData,
  composedThemeCss: string,
  cliPkgRoot: string,
  devPaths?: { cwd: string; cacheDir: string; base: string; themeAssetsDir?: string },
) {
  const cliPkgJson = path.join(cliPkgRoot, 'package.json');

  return {
    name: 'glyphrig-virtual-data',
    async resolveId(
      this: {
        resolve: (
          source: string,
          importer?: string,
          options?: Record<string, unknown>,
        ) => Promise<{ id: string } | null>;
      },
      id: string,
      importer?: string,
      options?: Record<string, unknown>,
    ) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_ID;
      }
      if (id === VIRTUAL_THEME_CSS_ID) {
        return RESOLVED_VIRTUAL_THEME_CSS_ID;
      }
      if (id === VIRTUAL_HELPERS_ID) {
        return SITE_HELPERS_PATH;
      }
      if (
        importer &&
        importer !== cliPkgJson &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('\0') &&
        !id.startsWith('virtual:') &&
        !id.startsWith('astro:') &&
        !id.startsWith('node:') &&
        !id.includes('://')
      ) {
        const direct = await this.resolve(id, importer, { ...options, skipSelf: true });
        if (direct) return direct;
        return this.resolve(id, cliPkgJson, { ...options, skipSelf: true });
      }
      return undefined;
    },
    load(id: string) {
      if (id === RESOLVED_VIRTUAL_ID) {
        return `export const siteData = ${JSON.stringify(siteData)};`;
      }
      if (id === RESOLVED_VIRTUAL_THEME_CSS_ID) {
        return composedThemeCss;
      }
      return undefined;
    },
    configureServer(server: {
      middlewares: {
        use: (
          fn: (
            req: { url?: string },
            res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: Buffer | string) => void },
            next: () => void,
          ) => void,
        ) => void;
      };
    }) {
      if (!devPaths) return;
      server.middlewares.use((req, res, next) => {
        const reqUrl = (req.url ?? '').split('?')[0] ?? '';
        const base = devPaths.base;
        const rel = reqUrl.startsWith(base) ? reqUrl.slice(base.length) : reqUrl.replace(/^\/+/, '');

        if (rel === 'glyphrig-icon.svg') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/svg+xml');
          res.end(DEFAULT_ICON_SVG);
          return;
        }
        if (rel.startsWith('favicons/')) {
          const decoded = safeDecodeUriPath(rel);
          if (!decoded) return next();
          const safeName = path.basename(decoded);
          const target = path.join(devPaths.cacheDir, 'favicons', safeName);
          fs.readFile(target)
            .then((buf) => {
              res.statusCode = 200;
              res.setHeader('Content-Type', guessMimeType(target));
              res.end(buf);
            })
            .catch(() => next());
          return;
        }
        if (rel.startsWith('assets/')) {
          const decoded = safeDecodeUriPath(rel.slice('assets/'.length));
          if (!decoded) return next();
          const candidate = path.resolve(devPaths.cwd, 'assets', decoded);
          const assetsRoot = path.resolve(devPaths.cwd, 'assets');
          if (candidate.startsWith(assetsRoot + path.sep)) {
            fs.readFile(candidate)
              .then((buf) => {
                res.statusCode = 200;
                res.setHeader('Content-Type', guessMimeType(candidate));
                res.end(buf);
              })
              .catch(() => next());
            return;
          }
        }
        if (devPaths.themeAssetsDir && rel.startsWith('theme-assets/')) {
          const decoded = safeDecodeUriPath(rel.slice('theme-assets/'.length));
          if (!decoded) return next();
          const themeAssetsRoot = path.resolve(devPaths.themeAssetsDir);
          const candidate = path.resolve(themeAssetsRoot, decoded);
          if (candidate.startsWith(themeAssetsRoot + path.sep)) {
            fs.readFile(candidate)
              .then((buf) => {
                res.statusCode = 200;
                res.setHeader('Content-Type', guessMimeType(candidate));
                res.end(buf);
              })
              .catch(() => next());
            return;
          }
        }
        next();
      });
    },
  };
}

export async function buildSite(options: BuildSiteOptions = {}): Promise<BuildSiteResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const inputDir = path.resolve(cwd, options.inputDir ?? 'bookmarks');
  const outDir = path.resolve(cwd, options.outDir ?? 'dist');
  const cacheDir = path.resolve(cwd, options.cacheDir ?? '.glyphrig-cache');

  const { siteData, enrichStats, resolvedTheme, composedThemeCss } = await prepareSiteData({
    cwd,
    inputDir,
    configPath: options.configPath,
    cacheDir,
    cliBase: options.base,
    cliTheme: options.theme,
    noEnrich: options.noEnrich,
    allowPrivateUrlsForTest: options.allowPrivateUrlsForTest,
  });

  assertSafeOutDir(outDir, [
    { label: 'working directory', dir: cwd },
    { label: 'bookmarks input directory', dir: inputDir },
    { label: 'cache directory', dir: cacheDir },
  ]);

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  // Astro writes `.prerender/prerender-entry.*.mjs` inside `astroOutDir` and imports it
  // with Node's ESM resolver, which walks up from `astroOutDir` for `node_modules` (e.g.
  // `piccolore`). Staging inside the CLI package root ensures `node_modules` is always
  // an ancestor even when `npx @glyphrig/cli build` runs in a data-only repo.
  const cliPkgRoot = path.resolve(import.meta.dirname, '..');
  const plugin = createVirtualDataPlugin(siteData, composedThemeCss, cliPkgRoot);
  const astroOutDir = path.join(
    cliPkgRoot,
    `.glyphrig-stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const prevCwd = process.cwd();
  process.chdir(cliPkgRoot);

  try {
    await astroBuild(
      {
        configFile: false,
        root: resolvedTheme.astroRoot,
        outDir: astroOutDir,
        cacheDir: path.join(cacheDir, 'astro'),
        base: siteData.config.site.base,
        ...(siteData.config.site.url ? { site: siteData.config.site.url } : {}),
        vite: {
          cacheDir: path.join(cacheDir, 'vite'),
          plugins: [plugin as never],
          server: {
            fs: {
              allow: [resolvedTheme.astroRoot, SITE_ROOT, cliPkgRoot, cwd],
            },
          },
        },
        logLevel: 'warn',
      },
      // Skip `syncInternal` so Astro never writes `.astro/` inside read-only `SITE_ROOT`
      { sync: false } as never,
    );

    await copyDirRecursive(astroOutDir, outDir);
  } finally {
    process.chdir(prevCwd);
    await fs.rm(astroOutDir, { recursive: true, force: true });
  }

  // Copy referenced downloaded favicons into dist/favicons/
  const referencedFavicons = new Set<string>();
  for (const bm of siteData.allBookmarks) {
    if (bm.faviconPath) referencedFavicons.add(path.basename(bm.faviconPath));
  }
  if (referencedFavicons.size > 0) {
    const outFavDir = path.join(outDir, 'favicons');
    await fs.mkdir(outFavDir, { recursive: true });
    for (const fileName of referencedFavicons) {
      const src = path.join(cacheDir, 'favicons', fileName);
      if (await exists(src)) {
        await fs.copyFile(src, path.join(outFavDir, fileName));
      }
    }
  }

  // Copy theme assets/ directory if present
  if (resolvedTheme.assetsDir && (await exists(resolvedTheme.assetsDir))) {
    await copyDirRecursive(resolvedTheme.assetsDir, path.join(outDir, 'theme-assets'));
  }

  // Copy user assets/ directory if present
  const userAssetsDir = path.join(cwd, 'assets');
  if (await exists(userAssetsDir)) {
    await copyDirRecursive(userAssetsDir, path.join(outDir, 'assets'));
  }

  // Write default SVG icon
  await fs.writeFile(path.join(outDir, 'glyphrig-icon.svg'), DEFAULT_ICON_SVG, 'utf8');

  // Emit base-aware service worker
  if (siteData.config.pwa.enabled) {
    const versionHash = crypto
      .createHash('sha256')
      .update(siteData.generatedAt + siteData.allBookmarks.length.toString())
      .digest('hex')
      .slice(0, 10);
    const swScript = generateServiceWorkerScript({
      base: siteData.config.site.base,
      versionHash,
    });
    await fs.writeFile(path.join(outDir, 'sw.js'), swScript, 'utf8');
  }

  // Run Pagefind indexing and always close the service so the Node process exits cleanly
  try {
    const { index, errors } = await pagefind.createIndex();
    if (!index || errors.length > 0) {
      throw new Error(`Pagefind createIndex failed: ${errors.join('; ')}`);
    }
    const dirResult = await index.addDirectory({ path: outDir });
    if (dirResult.errors.length > 0) {
      throw new Error(`Pagefind addDirectory failed: ${dirResult.errors.join('; ')}`);
    }
    const writeResult = await index.writeFiles({
      outputPath: path.join(outDir, 'pagefind'),
    });
    if (writeResult.errors.length > 0) {
      throw new Error(`Pagefind writeFiles failed: ${writeResult.errors.join('; ')}`);
    }
  } finally {
    await pagefind.close();
  }

  return {
    outDir,
    bookmarkCount: siteData.allBookmarks.length,
    folderCount: siteData.flatFolders.length + 1,
    enrichStats,
    config: siteData.config,
    themeName: resolvedTheme.name,
  };
}

export interface DevSiteOptions {
  cwd?: string;
  inputDir?: string;
  configPath?: string;
  cacheDir?: string;
  base?: string;
  theme?: string;
  port?: number;
  noEnrich?: boolean;
}

export async function devSite(
  options: DevSiteOptions = {},
): Promise<{ address: { port: number }; stop(): Promise<void> }> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const inputDir = path.resolve(cwd, options.inputDir ?? 'bookmarks');
  const cacheDir = path.resolve(cwd, options.cacheDir ?? '.glyphrig-cache');

  const { siteData, resolvedTheme, composedThemeCss } = await prepareSiteData({
    cwd,
    inputDir,
    configPath: options.configPath,
    cacheDir,
    cliBase: options.base,
    cliTheme: options.theme,
    noEnrich: options.noEnrich,
  });

  await fs.mkdir(cacheDir, { recursive: true });
  const cliPkgRoot = path.resolve(import.meta.dirname, '..');
  const plugin = createVirtualDataPlugin(siteData, composedThemeCss, cliPkgRoot, {
    cwd,
    cacheDir,
    base: siteData.config.site.base,
    ...(resolvedTheme.assetsDir ? { themeAssetsDir: resolvedTheme.assetsDir } : {}),
  });

  return astroDev({
    configFile: false,
    root: resolvedTheme.astroRoot,
    cacheDir: path.join(cacheDir, 'astro'),
    base: siteData.config.site.base,
    ...(siteData.config.site.url ? { site: siteData.config.site.url } : {}),
    server: {
      port: options.port ?? 4321,
    },
    vite: {
      cacheDir: path.join(cacheDir, 'vite'),
      plugins: [plugin as never],
      server: {
        fs: {
          allow: [resolvedTheme.astroRoot, SITE_ROOT, cliPkgRoot, cwd],
        },
      },
    },
    logLevel: 'info',
  });
}
