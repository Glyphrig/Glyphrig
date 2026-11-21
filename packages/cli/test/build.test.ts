import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSite } from '../src/astro-runner.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glyphrig-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('Astro + Pagefind site build', () => {
  it('builds nested folders, tags, feeds, manifest, sw.js, and pagefind index with subpath base', async () => {
    const repoDir = await makeTempDir();
    const outDir = path.join(repoDir, 'dist');
    const cacheDir = path.join(repoDir, '.glyphrig-cache');

    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      [
        'site:',
        '  title: Test Garden',
        '  description: Curated test links',
        '  url: https://example.github.io',
        'theme:',
        '  accent: "#b45309"',
        '  defaultView: list',
        'pwa:',
        '  enabled: true',
        '  quickAdd:',
        '    enabled: true',
        '    forge: github',
        '    owner: alice',
        '    repo: links',
      ].join('\n'),
      'utf8',
    );

    await fs.mkdir(path.join(repoDir, 'bookmarks/dev/web'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'bookmarks/README.md'),
      '---\ntitle: Home\norder: 0\n---\n\nWelcome intro.\n\n- [Glyphrig](https://glyphrig.dev) `#meta` <!-- glyphrig: added=2026-11-21 -->\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'bookmarks/dev/README.md'),
      '---\ntitle: Dev\norder: 0\ndescription: Developer resources\n---\n\n- [Rust](https://www.rust-lang.org) — Systems programming `#rust` <!-- glyphrig: added=2026-11-20 -->\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'bookmarks/dev/web/README.md'),
      '---\ntitle: Web\norder: 0\n---\n\n- [Astro](https://astro.build) — Static site framework `#web` `#ssg` <!-- glyphrig: added=2026-11-19 -->\n',
      'utf8',
    );

    const result = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir,
      base: '/demo/',
      noEnrich: true,
    });

    expect(result.bookmarkCount).toBe(3);
    expect(result.folderCount).toBe(3);

    const expectedFiles = [
      'index.html',
      'f/dev/index.html',
      'f/dev/web/index.html',
      'tags/index.html',
      'tags/web/index.html',
      'recent/index.html',
      'rss.xml',
      'feed.json',
      'manifest.webmanifest',
      'sw.js',
      'glyphrig-icon.svg',
      'pagefind/pagefind.js',
    ];

    for (const rel of expectedFiles) {
      const stat = await fs.stat(path.join(outDir, rel));
      expect(stat.isFile(), `Expected ${rel} to be built`).toBe(true);
    }

    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(indexHtml).toContain('/demo/f/dev/');
    expect(indexHtml).toContain('/demo/manifest.webmanifest');
    expect(indexHtml).toContain('Welcome intro.');

    const manifest = JSON.parse(
      await fs.readFile(path.join(outDir, 'manifest.webmanifest'), 'utf8'),
    ) as { start_url: string; share_target: { action: string } };
    expect(manifest.start_url).toBe('/demo/');
    expect(manifest.share_target.action).toBe('/demo/');
  }, 30000);
});
