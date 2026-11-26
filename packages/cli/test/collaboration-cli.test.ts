import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAutoTagRulesToRepo,
  buildSite,
  checkBookmarkLinks,
  formatBookmarksDigest,
  formatValidationPrComment,
  generateBookmarksDigest,
  importBookmarksFromFile,
  loadLinkHealthCache,
  parseImportedBookmarks,
  validateBookmarksRepo,
} from '../src/index.js';

const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glyphrig-cli-collab-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('bookmark importers (Netscape, Raindrop, Pinboard, Pocket, Linkding, Karakeep)', () => {
  it('auto-detects and parses all 6 external formats', () => {
    const netscape = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <DT><H3>Engineering</H3>
        <DL><p>
          <DT><A HREF="https://rust-lang.org?utm_source=x" ADD_DATE="1732492800" TAGS="rust,systems">Rust</A>
          <DD>Fast and safe
        </DL><p>
      </DL><p>`;
    const ns = parseImportedBookmarks(netscape, 'auto', 'bookmarks.html');
    expect(ns.format).toBe('netscape');
    expect(ns.records[0]).toMatchObject({
      title: 'Rust',
      folderSegments: ['Engineering'],
      note: 'Fast and safe',
      tags: ['rust', 'systems'],
    });

    const raindrop = `title,note,excerpt,url,folder,tags,created
"MDN Docs","Handy ref","","https://developer.mozilla.org","Web/Reference","docs, web","2026-11-10T00:00:00Z"`;
    const rd = parseImportedBookmarks(raindrop, 'auto', 'raindrop.csv');
    expect(rd.format).toBe('raindrop');
    expect(rd.records[0]?.folderSegments).toEqual(['Web', 'Reference']);
    expect(rd.records[0]?.tags).toEqual(['docs', 'web']);

    const pinboard = JSON.stringify([
      {
        href: 'https://sqlite.org',
        description: 'SQLite',
        extended: 'Embedded SQL',
        tags: 'db sql',
        time: '2026-11-05T12:00:00Z',
      },
    ]);
    const pb = parseImportedBookmarks(pinboard, 'auto', 'pinboard.json');
    expect(pb.format).toBe('pinboard');
    expect(pb.records[0]).toMatchObject({ title: 'SQLite', note: 'Embedded SQL', tags: ['db', 'sql'] });

    const pocket = `title,url,time_added,tags
"Pocket Read","https://example.com/read","1732492800","reading|longform"`;
    const pk = parseImportedBookmarks(pocket, 'auto', 'pocket.csv');
    expect(pk.format).toBe('pocket');
    expect(pk.records[0]?.tags).toEqual(['reading', 'longform']);

    const linkding = JSON.stringify({
      results: [
        {
          url: 'https://astro.build',
          title: 'Astro',
          notes: 'Static sites',
          tag_names: ['ssg', 'web'],
          date_added: '2026-11-12T00:00:00Z',
        },
      ],
    });
    const ld = parseImportedBookmarks(linkding, 'auto', 'linkding.json');
    expect(ld.format).toBe('linkding');
    expect(ld.records[0]?.tags).toEqual(['ssg', 'web']);

    const karakeep = JSON.stringify({
      bookmarks: [
        {
          createdAt: '2026-11-15T00:00:00Z',
          note: 'Great explainer',
          tags: [{ name: 'ai' }],
          content: { url: 'https://example.org/ai', title: 'AI Explainer' },
        },
      ],
    });
    const kk = parseImportedBookmarks(karakeep, 'auto', 'karakeep.json');
    expect(kk.format).toBe('karakeep');
    expect(kk.records[0]).toMatchObject({ title: 'AI Explainer', note: 'Great explainer', tags: ['ai'] });
  });

  it('imports safely into bookmarks/, filters private URLs, deduplicates, and applies autoTagRules', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'glyphrig.config.yaml'),
      `enrichment:\n  autoTagRules:\n    - match: github.com/*/*\n      tags: [oss]\n`,
    );
    const src = path.join(dir, 'export.json');
    await fs.writeFile(
      src,
      JSON.stringify([
        { href: 'https://github.com/Glyphrig/Glyphrig?utm_campaign=launch', description: 'Glyphrig', tags: 'bookmarks' },
        { href: 'http://localhost:3000/secret', description: 'Local Dev', tags: 'dev' },
      ]),
    );

    const res = await importBookmarksFromFile({
      sourceFile: src,
      inputDir: path.join(dir, 'bookmarks'),
      cwd: dir,
      user: 'alice',
    });

    expect(res.added).toBe(1);
    expect(res.skippedUnsafe).toBe(1);
    const md = await fs.readFile(path.join(dir, 'bookmarks', 'README.md'), 'utf8');
    expect(md).toContain('https://github.com/Glyphrig/Glyphrig)');
    expect(md).toContain('`#bookmarks` `#oss`');
    expect(md).toContain('by=alice');
    expect(md).not.toContain('localhost');
  });
});

describe('link-health, Wayback lookup, digest, auto-tag & duplicate validation', () => {
  it('checks links, finds Wayback snapshot for 404, writes cache and optional archive metadata', async () => {
    const dir = await makeTempDir();
    const bmDir = path.join(dir, 'bookmarks');
    await fs.mkdir(bmDir, { recursive: true });
    await fs.writeFile(
      path.join(bmDir, 'README.md'),
      `---\ntitle: Links\norder: 0\n---\n\n- [Alive](https://alive.example/page)\n- [Gone](https://gone.example/old)\n`,
    );

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://alive.example/')) {
        return new Response('', { status: 200 });
      }
      if (url.startsWith('https://gone.example/')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.startsWith('https://archive.org/wayback/available')) {
        return new Response(
          JSON.stringify({
            archived_snapshots: {
              closest: {
                available: true,
                url: 'http://web.archive.org/web/20250101000000/https://gone.example/old',
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('', { status: 500 });
    };

    const cacheDir = path.join(dir, '.glyphrig-cache');
    const report = await checkBookmarkLinks({
      inputDir: bmDir,
      cacheDir,
      writeArchives: true,
      fetchFn: mockFetch,
    });

    expect(report.ok).toBe(1);
    expect(report.dead).toBe(1);
    expect(report.waybackFound).toBe(1);
    expect(report.filesUpdated).toHaveLength(1);

    const cached = await loadLinkHealthCache(cacheDir);
    expect(cached.get('https://gone.example/old')?.waybackUrl).toBe(
      'https://web.archive.org/web/20250101000000/https://gone.example/old',
    );

    const updatedMd = await fs.readFile(path.join(bmDir, 'README.md'), 'utf8');
    expect(updatedMd).toContain(
      'archive=https://web.archive.org/web/20250101000000/https://gone.example/old',
    );
  });

  it('generates multi-format digests, detects cross-folder duplicates, and runs auto-tag', async () => {
    const dir = await makeTempDir();
    const bmDir = path.join(dir, 'bookmarks');
    await fs.mkdir(path.join(bmDir, 'a'), { recursive: true });
    await fs.mkdir(path.join(bmDir, 'b'), { recursive: true });

    await fs.writeFile(
      path.join(dir, 'glyphrig.config.yaml'),
      `site:\n  title: Team Garden\n  url: https://team.example\nenrichment:\n  autoTagRules:\n    - match: arxiv.org\n      tags: [papers]\n`,
    );
    await fs.writeFile(
      path.join(bmDir, 'a', 'README.md'),
      `---\ntitle: Research\norder: 1\n---\n\n- [Great Paper](https://arxiv.org/abs/2501.0001) <!-- glyphrig: added=2026-11-24 by=alice,bob -->\n  - **@alice**: Must read\n`,
    );
    await fs.writeFile(
      path.join(bmDir, 'b', 'README.md'),
      `---\ntitle: Reading\norder: 2\n---\n\n- [Great Paper](https://arxiv.org/abs/2501.0001) <!-- glyphrig: added=2026-11-24 by=carol -->\n`,
    );

    const validation = await validateBookmarksRepo({ inputDir: bmDir, cwd: dir });
    expect(validation.valid).toBe(true);
    expect(validation.duplicates).toHaveLength(1);
    expect(validation.duplicates[0]?.folders).toEqual(['a', 'b']);
    expect(formatValidationPrComment(validation)).toContain('Cross-Folder Duplicates');

    const autoTagRes = await applyAutoTagRulesToRepo({
      inputDir: bmDir,
      cwd: dir,
      write: true,
    });
    expect(autoTagRes.bookmarksUpdated).toBe(2);

    const digest = await generateBookmarksDigest({
      inputDir: bmDir,
      cwd: dir,
      days: 7,
      now: new Date('2026-11-25T12:00:00Z'),
    });
    expect(digest.recentBookmarks).toHaveLength(2);
    expect(digest.popularBookmarks).toHaveLength(1);
    expect(digest.popularBookmarks[0]?.savedBy).toEqual(['alice', 'bob', 'carol']);

    expect(formatBookmarksDigest(digest, 'markdown')).toContain('@alice: Must read');
    expect(JSON.parse(formatBookmarksDigest(digest, 'slack')).blocks.length).toBeGreaterThan(1);
    expect(JSON.parse(formatBookmarksDigest(digest, 'discord')).embeds).toHaveLength(1);
    expect(JSON.parse(formatBookmarksDigest(digest, 'matrix')).msgtype).toBe('m.notice');
  });

  it('escapes HTML/mrkdwn in digests, handles SVG ICONs + BOM in importers, and rejects unsafe build --out .', async () => {
    const dir = await makeTempDir();
    const bmDir = path.join(dir, 'bookmarks');
    await fs.mkdir(bmDir, { recursive: true });
    await fs.writeFile(
      path.join(bmDir, 'README.md'),
      `---\ntitle: Security\norder: 0\n---\n\n- [XSS <script>alert(1)</script> | <!channel>](https://sec.example/page) <!-- glyphrig: added=2026-11-24 by=alice -->\n`,
    );

    const digest = await generateBookmarksDigest({
      inputDir: bmDir,
      cwd: dir,
      days: 7,
      now: new Date('2026-11-25T12:00:00Z'),
    });

    const matrix = JSON.parse(formatBookmarksDigest(digest, 'matrix')) as {
      formatted_body: string;
    };
    expect(matrix.formatted_body).not.toContain('<script>');
    expect(matrix.formatted_body).toContain('&lt;script&gt;');

    const slackStr = formatBookmarksDigest(digest, 'slack');
    expect(slackStr).not.toContain('<!channel>');

    const discord = JSON.parse(formatBookmarksDigest(digest, 'discord')) as {
      allowed_mentions?: { parse: string[] };
    };
    expect(discord.allowed_mentions).toEqual({ parse: [] });

    expect(() =>
      formatBookmarksDigest(digest, 'invalid-format' as unknown as 'markdown'),
    ).toThrow(/Invalid digest format/);

    // Netscape HTML with embedded SVG data URI in ICON attribute + UTF-8 BOM JSON
    const svgNetscape = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://svg.example/doc" ICON="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>">SVG Icon Link</A></DL>`;
    const parsedSvg = parseImportedBookmarks(svgNetscape, 'auto', 'bookmarks.html');
    expect(parsedSvg.records).toHaveLength(1);
    expect(parsedSvg.records[0]?.title).toBe('SVG Icon Link');

    const bomPinboard = `\uFEFF[{"href":"https://bom.example/a","description":"BOM Link","tags":"dev"}]`;
    const parsedBom = parseImportedBookmarks(bomPinboard, 'auto', 'pinboard.json');
    expect(parsedBom.format).toBe('pinboard');
    expect(parsedBom.records[0]?.title).toBe('BOM Link');

    // buildSite refuses dangerous output dir '.' (cwd)
    await expect(
      buildSite({ cwd: dir, inputDir: bmDir, outDir: dir }),
    ).rejects.toThrow(/Refusing to delete/);
  });
});
