import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSite } from '../src/astro-runner.js';
import { validateBookmarksRepo } from '../src/loader.js';
import {
  BUILTIN_THEMES,
  ejectDefaultTheme,
  resolveTheme,
  scaffoldTheme,
} from '../src/theme.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glyphrig-theme-'));
  tempDirs.push(dir);
  return dir;
}

async function seedMinimalBookmarks(repoDir: string): Promise<void> {
  await fs.mkdir(path.join(repoDir, 'bookmarks/dev'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, 'bookmarks/README.md'),
    '---\ntitle: Home\norder: 0\n---\n\n- [Glyphrig](https://glyphrig.dev) `#meta` <!-- glyphrig: added=2026-11-21 by=alice -->\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(repoDir, 'bookmarks/dev/README.md'),
    '---\ntitle: Dev\norder: 0\n---\n\n- [Astro](https://astro.build) — Static site framework `#web` <!-- glyphrig: added=2026-11-20 by=alice -->\n',
    'utf8',
  );
}

async function readBuiltCss(outDir: string): Promise<string> {
  const parts: string[] = [];
  const astroDir = path.join(outDir, '_astro');
  try {
    const entries = await fs.readdir(astroDir);
    const cssFiles = entries.filter((f) => f.endsWith('.css'));
    for (const f of cssFiles) {
      parts.push(await fs.readFile(path.join(astroDir, f), 'utf8'));
    }
  } catch {
    // No _astro directory when all styles are inlined
  }
  const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  for (const match of indexHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    parts.push(match[1] ?? '');
  }
  return parts.join('\n');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('custom themes', () => {
  it('supports built-in presets, applies preset defaults, and respects explicit accent overrides', async () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual([
      'editorial',
      'minimal',
      'terminal',
      'nord',
    ]);

    const repoDir = await makeTempDir();
    await seedMinimalBookmarks(repoDir);
    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      ['site:', '  title: Terminal Links', 'theme: terminal'].join('\n'),
      'utf8',
    );

    const outDir = path.join(repoDir, 'dist');
    const result = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir: path.join(repoDir, '.glyphrig-cache'),
      base: '/',
      noEnrich: true,
    });

    expect(result.themeName).toBe('terminal');
    expect(result.config.theme.colorScheme).toBe('dark');
    expect(result.config.theme.accent).toBe('#22c55e');

    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(indexHtml).toContain('data-color-scheme="dark"');
    expect(indexHtml).toContain('data-theme-name="terminal"');

    const css = await readBuiltCss(outDir);
    expect(css).toContain('#22c55e');
    expect(css).toContain('.app-shell');

    // Explicit accent in config overrides theme default
    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      [
        'site:',
        '  title: Terminal Links',
        'theme:',
        '  use: terminal',
        '  accent: "#38bdf8"',
        '  colorScheme: light',
      ].join('\n'),
      'utf8',
    );
    const overrideRes = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir: path.join(repoDir, '.glyphrig-cache'),
      base: '/',
      noEnrich: true,
    });
    expect(overrideRes.config.theme.colorScheme).toBe('light');
    expect(overrideRes.config.theme.accent).toBe('#38bdf8');
    const overrideCss = await readBuiltCss(outDir);
    expect(overrideCss).toContain('#38bdf8');
  }, 30000);

  it('builds a local CSS theme directory with theme.yaml, head.html {{base}}, assets/, and mode: replace', async () => {
    const repoDir = await makeTempDir();
    await seedMinimalBookmarks(repoDir);

    const themeDir = path.join(repoDir, 'theme');
    await scaffoldTheme({
      targetDir: themeDir,
      type: 'css',
      mode: 'replace',
      name: 'oceanic',
    });

    await fs.writeFile(
      path.join(themeDir, 'theme.css'),
      ':root { --bg: #012345; }\n.custom-ocean-marker { color: #0ea5e9; }\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(themeDir, 'head.html'),
      '<link rel="stylesheet" href="{{base}}theme-assets/extra.css" />\n',
      'utf8',
    );
    await fs.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(themeDir, 'assets/extra.css'),
      '/* theme asset */\n',
      'utf8',
    );

    await fs.mkdir(path.join(repoDir, 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'assets/custom.css'),
      '.user-override-marker { color: #f43f5e; }\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'assets/head.html'),
      '<meta name="x-custom-head" content="{{base}}ok" />\n',
      'utf8',
    );

    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      [
        'site:',
        '  title: Ocean Bookmarks',
        'theme:',
        '  use: ./theme',
        '  customCss: assets/custom.css',
        '  customHead: assets/head.html',
      ].join('\n'),
      'utf8',
    );

    const outDir = path.join(repoDir, 'dist');
    const result = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir: path.join(repoDir, '.glyphrig-cache'),
      base: '/ocean/',
      noEnrich: true,
    });

    expect(result.themeName).toBe('oceanic');

    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(indexHtml).toContain('data-theme-name="oceanic"');
    expect(indexHtml).toContain('href="/ocean/theme-assets/extra.css"');
    expect(indexHtml).toContain('content="/ocean/ok"');

    // Theme asset copied into dist/theme-assets/
    const copiedAsset = await fs.readFile(
      path.join(outDir, 'theme-assets/extra.css'),
      'utf8',
    );
    expect(copiedAsset).toContain('theme asset');

    // mode: replace omits default .app-shell layout rules, keeps theme.css + customCss
    const css = await readBuiltCss(outDir);
    expect(css).toContain('custom-ocean-marker');
    expect(css).toContain('user-override-marker');
    expect(css).not.toContain('.sidebar-backdrop');
  }, 30000);

  it('builds a scaffolded custom Astro theme in an isolated repo with no node_modules', async () => {
    const repoDir = await makeTempDir();
    await seedMinimalBookmarks(repoDir);

    const themeDir = path.join(repoDir, 'my-astro-theme');
    const scaffolded = await scaffoldTheme({
      targetDir: themeDir,
      type: 'astro',
      name: 'my-astro-theme',
    });
    expect(scaffolded.created).toContain('src/pages/index.astro');
    expect(scaffolded.created).toContain('src/pages/f/[...folder].astro');

    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      ['site:', '  title: Custom Astro Garden', 'theme:', '  use: ./my-astro-theme'].join('\n'),
      'utf8',
    );

    const outDir = path.join(repoDir, 'dist');
    const result = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir: path.join(repoDir, '.glyphrig-cache'),
      base: '/custom/',
      noEnrich: true,
    });

    expect(result.themeName).toBe('my-astro-theme');
    expect(result.bookmarkCount).toBe(2);

    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(indexHtml).toContain('Custom Astro Garden');
    expect(indexHtml).toContain('/custom/f/dev/');
    expect(indexHtml).toContain('https://glyphrig.dev');

    const devHtml = await fs.readFile(path.join(outDir, 'f/dev/index.html'), 'utf8');
    expect(devHtml).toContain('https://astro.build');

    const rss = await fs.readFile(path.join(outDir, 'rss.xml'), 'utf8');
    expect(rss).toContain('Custom Astro Garden');

    const pagefindStat = await fs.stat(path.join(outDir, 'pagefind/pagefind.js'));
    expect(pagefindStat.isFile()).toBe(true);
  }, 30000);

  it('ejects the full default Astro theme and builds it cleanly without local node_modules', async () => {
    const repoDir = await makeTempDir();
    await seedMinimalBookmarks(repoDir);

    const themeDir = path.join(repoDir, 'ejected-theme');
    const ejected = await ejectDefaultTheme({
      targetDir: themeDir,
      name: 'ejected-custom',
    });
    expect(ejected.created).toContain('theme.yaml');
    expect(ejected.created).toContain('src/layouts/BaseLayout.astro');

    // Customize a visible template marker inside the ejected layout
    const layoutPath = path.join(themeDir, 'src/layouts/BaseLayout.astro');
    const origLayout = await fs.readFile(layoutPath, 'utf8');
    await fs.writeFile(
      layoutPath,
      origLayout.replace('</body>', '<!-- ejected-theme-verified --></body>'),
      'utf8',
    );

    const outDir = path.join(repoDir, 'dist');
    const result = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir: path.join(repoDir, '.glyphrig-cache'),
      base: '/',
      theme: './ejected-theme',
      noEnrich: true,
    });

    expect(result.themeName).toBe('ejected-custom');
    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(indexHtml).toContain('ejected-theme-verified');
    expect(indexHtml).toContain('data-theme-name="ejected-custom"');
  }, 30000);

  it('reports invalid theme.use and missing customCss/customHead during validateBookmarksRepo', async () => {
    const repoDir = await makeTempDir();
    await seedMinimalBookmarks(repoDir);

    await expect(resolveTheme('./does-not-exist', repoDir)).rejects.toThrow(
      /Theme path not found/,
    );

    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      [
        'site:',
        '  title: Broken Theme Test',
        'theme:',
        '  use: nonexistent-theme-pkg',
        '  customCss: assets/missing.css',
        '  customHead: assets/missing-head.html',
      ].join('\n'),
      'utf8',
    );

    const report = await validateBookmarksRepo({
      cwd: repoDir,
      inputDir: 'bookmarks',
    });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes('nonexistent-theme-pkg'))).toBe(true);
    expect(report.errors.some((e) => e.includes('missing.css'))).toBe(true);
    expect(report.errors.some((e) => e.includes('missing-head.html'))).toBe(true);
  });

  it('resolves a standalone .css file path and an npm theme package from node_modules', async () => {
    const repoDir = await makeTempDir();
    await fs.writeFile(
      path.join(repoDir, 'standalone.css'),
      ':root { --accent: #ec4899; }\n',
      'utf8',
    );
    const cssResolved = await resolveTheme('./standalone.css', repoDir);
    expect(cssResolved.source).toBe('css-file');
    expect(cssResolved.mode).toBe('extend');
    expect(cssResolved.cssContent).toContain('#ec4899');

    // Simulated installed npm theme package with custom glyphrigTheme directory
    const pkgDir = path.join(repoDir, 'node_modules/glyphrig-theme-sample');
    await fs.mkdir(path.join(pkgDir, 'dist-theme'), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'glyphrig-theme-sample', version: '1.0.0', glyphrigTheme: 'dist-theme' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(pkgDir, 'dist-theme/theme.yaml'),
      'name: Sample Package Theme\nmode: extend\ndefaults:\n  accent: "#8b5cf6"\n  colorScheme: dark\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(pkgDir, 'dist-theme/theme.css'),
      ':root { --accent: #8b5cf6; }\n',
      'utf8',
    );

    const pkgResolved = await resolveTheme('glyphrig-theme-sample', repoDir);
    expect(pkgResolved.source).toBe('package');
    expect(pkgResolved.name).toBe('Sample Package Theme');
    expect(pkgResolved.defaults.accent).toBe('#8b5cf6');
    expect(pkgResolved.defaults.colorScheme).toBe('dark');
    expect(pkgResolved.cssContent).toContain('#8b5cf6');
  });
});
