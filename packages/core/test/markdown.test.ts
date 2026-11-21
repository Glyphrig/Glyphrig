import { describe, expect, it } from 'vitest';
import {
  assignSiblingSlugs,
  filePathToFolderPath,
  folderPathToFilePath,
  formatBookmarkLine,
  parseBookmarkLine,
  parseBookmarkRepoFiles,
  parseFolderMarkdown,
  serializeBookmarkTree,
  serializeFolderMarkdown,
  slugifyFolderName,
} from '../src/index.js';

describe('slug helpers', () => {
  it('slugifies accented and punctuated folder names deterministically', () => {
    expect(slugifyFolderName('Dev Tools & CLI')).toBe('dev-tools-cli');
    expect(slugifyFolderName('Café / Système')).toBe('cafe-systeme');
    expect(slugifyFolderName('   ---   ')).toBe('folder');
  });

  it('disambiguates sibling folder slug collisions', () => {
    expect(assignSiblingSlugs(['Tools', 'Tools!', 'Other', 'Tools?'])).toEqual([
      'tools',
      'tools-2',
      'other',
      'tools-3',
    ]);
  });

  it('converts between folder paths and repo file paths', () => {
    expect(folderPathToFilePath('bookmarks', '')).toBe('bookmarks/README.md');
    expect(folderPathToFilePath('bookmarks/', 'dev/web')).toBe('bookmarks/dev/web/README.md');
    expect(filePathToFolderPath('bookmarks', 'bookmarks/README.md')).toBe('');
    expect(filePathToFolderPath('bookmarks', 'bookmarks/dev/web/README.md')).toBe('dev/web');
    expect(filePathToFolderPath('bookmarks', 'bookmarks/dev/notes.txt')).toBeNull();
    expect(filePathToFolderPath('bookmarks', 'README.md')).toBeNull();
  });
});

describe('bookmark line & document parser/serializer', () => {
  it('parses balanced parentheses in URLs, escaped brackets, notes, tags, and glyphrig comments', () => {
    const line =
      '- [Rust \\[lang\\]](https://en.wikipedia.org/wiki/Rust_(programming_language)) — Systems language `#rust` `#systems` <!-- glyphrig: added=2026-11-21 -->';
    const parsed = parseBookmarkLine(line, 0);
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe('Rust [lang]');
    expect(parsed?.url).toBe('https://en.wikipedia.org/wiki/Rust_(programming_language)');
    expect(parsed?.note).toBe('Systems language');
    expect(parsed?.tags).toEqual(['rust', 'systems']);
    expect(parsed?.added).toBe('2026-11-21');

    const serialized = formatBookmarkLine(parsed!);
    expect(serialized).toBe(line);
  });

  it('preserves URL #fragments without mistaking them for #tags', () => {
    const line = '- [MDN Section](https://developer.mozilla.org/en-US/docs/Web#guides) `#docs`';
    const parsed = parseBookmarkLine(line, 0);
    expect(parsed?.url).toBe('https://developer.mozilla.org/en-US/docs/Web#guides');
    expect(parsed?.tags).toEqual(['docs']);
    expect(parsed?.note).toBeUndefined();
  });

  it('ignores links inside fenced code blocks when parsing a folder README.md', () => {
    const md = [
      '---',
      'title: Dev',
      'order: 1',
      'description: Dev links',
      'custom_field: keep-me',
      '---',
      '',
      'Intro paragraph.',
      '',
      '```markdown',
      '- [Fake Example](https://example.com/fake)',
      '```',
      '',
      '- [Astro](https://astro.build) — Static builder `#web` <!-- glyphrig: added=2026-11-20 -->',
      '',
    ].join('\n');

    const doc = parseFolderMarkdown(md, 'dev');
    expect(doc.title).toBe('Dev');
    expect(doc.order).toBe(1);
    expect(doc.description).toBe('Dev links');
    expect(doc.extraFrontmatter).toEqual({ custom_field: 'keep-me' });
    expect(doc.bookmarks).toHaveLength(1);
    expect(doc.bookmarks[0]?.url).toBe('https://astro.build');

    // Simulate a browser sync updating the title while omitting note/tags/added
    const browserFolder = {
      path: 'dev',
      slug: 'dev',
      title: 'Dev',
      order: 1,
      description: 'Dev links',
      bookmarks: [
        {
          title: 'Astro Docs & Framework',
          url: 'https://astro.build',
          normalizedUrl: 'https://astro.build',
          tags: [],
          order: 0,
        },
        {
          title: 'WXT',
          url: 'https://wxt.dev',
          normalizedUrl: 'https://wxt.dev',
          added: '2026-11-21',
          tags: [],
          order: 1,
        },
      ],
      children: [],
    };

    const output = serializeFolderMarkdown(browserFolder, doc);
    expect(output).toContain('custom_field: keep-me');
    expect(output).toContain('Intro paragraph.');
    expect(output).toContain('- [Fake Example](https://example.com/fake)');
    expect(output).toContain(
      '- [Astro Docs & Framework](https://astro.build) — Static builder `#web` <!-- glyphrig: added=2026-11-20 -->',
    );
    expect(output).toContain('- [WXT](https://wxt.dev) <!-- glyphrig: added=2026-11-21 -->');
  });

  it('builds and re-serializes nested folder trees including virtual intermediate folders', () => {
    const files = new Map<string, string>([
      [
        'bookmarks/README.md',
        '---\ntitle: Public Bookmarks\norder: 0\n---\n\nRoot intro.\n\n- [Glyphrig](https://glyphrig.dev)\n',
      ],
      [
        'bookmarks/dev/web/README.md',
        '---\ntitle: Web Dev\norder: 2\n---\n\n- [MDN](https://developer.mozilla.org)\n',
      ],
    ]);

    const { tree, rawDocs } = parseBookmarkRepoFiles(files, 'bookmarks');
    expect(tree.root.title).toBe('Public Bookmarks');
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0]?.path).toBe('dev');
    expect(tree.root.children[0]?.children[0]?.title).toBe('Web Dev');

    const reserialized = serializeBookmarkTree(tree, 'bookmarks', rawDocs);
    expect(reserialized.get('bookmarks/README.md')).toContain('Root intro.');
    expect(reserialized.get('bookmarks/dev/web/README.md')).toContain('title: Web Dev');
  });
});
