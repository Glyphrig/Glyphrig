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

  it('builds /popular/, /u/<user>/ contributor pages, deduplicates cross-folder popularity, and excludes .archived/', async () => {
    const repoDir = await makeTempDir();
    const outDir = path.join(repoDir, 'dist');
    const cacheDir = path.join(repoDir, '.glyphrig-cache');

    await fs.writeFile(
      path.join(repoDir, 'glyphrig.config.yaml'),
      ['site:', '  title: Team Bookmarks', '  url: https://example.github.io'].join('\n'),
      'utf8',
    );

    await fs.mkdir(path.join(repoDir, 'bookmarks/dev/.archived'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'bookmarks/reading'), { recursive: true });

    await fs.writeFile(
      path.join(repoDir, 'bookmarks/README.md'),
      '---\ntitle: Home\norder: 0\n---\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'bookmarks/dev/README.md'),
      [
        '---',
        'title: Dev',
        'order: 0',
        '---',
        '',
        '- [Shared Docs](https://shared.example.com) `#docs` <!-- glyphrig: added=2026-11-20 by=alice,bob -->',
        '- [Bob Only](https://bob.example.com) `#notes` <!-- glyphrig: added=2026-11-21 by=bob -->',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'bookmarks/reading/README.md'),
      [
        '---',
        'title: Reading',
        'order: 1',
        '---',
        '',
        '- [Shared Docs Mirror](https://shared.example.com) `#reading` <!-- glyphrig: added=2026-11-22 by=alice -->',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'bookmarks/dev/.archived/README.md'),
      [
        '---',
        'title: Dev (Archived)',
        'archived: true',
        '---',
        '',
        '- [Retired Link](https://archived.example.com) <!-- glyphrig: added=2026-11-01 archived=2026-11-21 -->',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir,
      base: '/',
      noEnrich: true,
    });

    expect(result.bookmarkCount).toBe(3);

    for (const rel of ['popular/index.html', 'u/index.html', 'u/alice/index.html', 'u/bob/index.html']) {
      const stat = await fs.stat(path.join(outDir, rel));
      expect(stat.isFile(), `Expected ${rel} to be built`).toBe(true);
    }

    const popularHtml = await fs.readFile(path.join(outDir, 'popular/index.html'), 'utf8');
    expect(popularHtml).toContain('https://shared.example.com');
    expect(popularHtml).toContain('https://bob.example.com');
    expect(popularHtml.indexOf('https://shared.example.com')).toBeLessThan(
      popularHtml.indexOf('https://bob.example.com'),
    );
    expect(popularHtml).toContain('2');
    expect(popularHtml).toContain('@alice');
    expect(popularHtml).toContain('@bob');
    expect(popularHtml).not.toContain('archived.example.com');

    const devHtml = await fs.readFile(path.join(outDir, 'f/dev/index.html'), 'utf8');
    expect(devHtml).not.toContain('archived.example.com');

    const aliceHtml = await fs.readFile(path.join(outDir, 'u/alice/index.html'), 'utf8');
    expect(aliceHtml).toContain('https://shared.example.com');
    expect(aliceHtml).toContain('1 unique bookmark');
    expect(aliceHtml).not.toContain('https://bob.example.com');

    const bobHtml = await fs.readFile(path.join(outDir, 'u/bob/index.html'), 'utf8');
    expect(bobHtml).toContain('https://shared.example.com');
    expect(bobHtml).toContain('https://bob.example.com');
    expect(bobHtml).toContain('2 unique bookmarks');
  }, 30000);
});
