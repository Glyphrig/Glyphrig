import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inspectUrlSafety,
  normalizeUserList,
  parseBookmarkRepoFiles,
  type BookmarkTree,
  type FolderNode,
} from '@glyphrig/core';
import type {
  ContributorSummary,
  EnrichedBookmark,
  EnrichedFolderNode,
  TagSummary,
} from '@glyphrig/site';
import { marked } from 'marked';
import type { EnrichedUrlMeta } from './enrich.js';
import { loadGlyphrigConfig } from './config.js';
import { resolveTheme } from './theme.js';

export async function readBookmarkDirectory(inputDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const resolvedInput = path.resolve(inputDir);

  async function walk(currentDir: string, relPrefix: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(absPath, relPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'readme.md') {
        const content = await fs.readFile(absPath, 'utf8');
        // Normalize virtual prefix to bookmarks/ so core parser maps accurately
        const repoPath = relPrefix ? `bookmarks/${relPrefix}/README.md` : 'bookmarks/README.md';
        files.set(repoPath, content);
      }
    }
  }

  try {
    const stat = await fs.stat(resolvedInput);
    if (!stat.isDirectory()) {
      throw new Error(`Bookmarks input path is not a directory: ${resolvedInput}`);
    }
    await walk(resolvedInput, '');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`Bookmarks directory not found: ${resolvedInput}`);
    }
    throw err;
  }

  return files;
}

function sanitizeRenderedHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function slugifyTagForRoute(tag: string, usedSlugs: Set<string>): string {
  const base =
    tag
      .toLowerCase()
      .replace(/\//g, '--')
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tag';
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  let n = 2;
  while (usedSlugs.has(`${base}-${n}`)) {
    n++;
  }
  const unique = `${base}-${n}`;
  usedSlugs.add(unique);
  return unique;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function buildEnrichedSiteTree(
  tree: BookmarkTree,
  enrichedByUrl: Map<string, EnrichedUrlMeta>,
  options: { fetchOgImage: boolean; autoTags: boolean },
): {
  root: EnrichedFolderNode;
  flatFolders: EnrichedFolderNode[];
  allBookmarks: EnrichedBookmark[];
  tags: TagSummary[];
  contributors: ContributorSummary[];
} {
  const flatFolders: EnrichedFolderNode[] = [];
  const allBookmarks: EnrichedBookmark[] = [];
  const tagCounts = new Map<string, number>();

  // First pass: collect unique contributors globally per normalizedUrl
  const globalSaversByUrl = new Map<string, Set<string>>();
  function collectGlobalSavers(folder: FolderNode): void {
    for (const bm of folder.bookmarks) {
      const savers = normalizeUserList(bm.savedBy);
      if (savers.length === 0) continue;
      const set = globalSaversByUrl.get(bm.normalizedUrl) ?? new Set<string>();
      for (const u of savers) set.add(u);
      globalSaversByUrl.set(bm.normalizedUrl, set);
    }
    for (const child of folder.children) {
      collectGlobalSavers(child);
    }
  }
  collectGlobalSavers(tree.root);

  const contributorUrls = new Map<string, Set<string>>();

  function convertFolder(
    folder: FolderNode,
    ancestors: Array<{ title: string; path: string }>,
  ): EnrichedFolderNode {
    const folderSegments = folder.path
      ? [...ancestors, { title: folder.title, path: folder.path }]
      : [];

    const introHtml = folder.introMarkdown
      ? sanitizeRenderedHtml(marked.parse(folder.introMarkdown, { async: false }) as string)
      : undefined;

    const bookmarks: EnrichedBookmark[] = folder.bookmarks.map((bm, idx) => {
      const meta = enrichedByUrl.get(bm.url);
      const mergedTags = [...bm.tags];
      if (options.autoTags && meta?.keywords) {
        for (const kw of meta.keywords) {
          if (mergedTags.length >= 8) break;
          if (!mergedTags.includes(kw)) mergedTags.push(kw);
        }
      }
      for (const t of mergedTags) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }

      const savedBy = normalizeUserList(bm.savedBy);
      const globalSavedBy = [...(globalSaversByUrl.get(bm.normalizedUrl) ?? [])].sort();
      for (const username of globalSavedBy) {
        const urls = contributorUrls.get(username) ?? new Set<string>();
        urls.add(bm.normalizedUrl);
        contributorUrls.set(username, urls);
      }

      const effectiveDescription = bm.note || meta?.description;
      const enriched: EnrichedBookmark = {
        ...bm,
        tags: mergedTags,
        savedBy,
        globalSavedBy,
        popularity: globalSavedBy.length,
        id: `${folder.path || 'root'}-${idx}-${bm.normalizedUrl}`,
        domain: extractDomain(bm.url),
        folderPath: folder.path,
        folderTitle: folder.title,
        folderSegments,
        ...(effectiveDescription ? { effectiveDescription } : {}),
        ...(options.fetchOgImage && meta?.ogImage ? { ogImage: meta.ogImage } : {}),
        ...(meta?.faviconRelPath ? { faviconPath: meta.faviconRelPath } : {}),
        ...(meta?.title ? { scrapedTitle: meta.title } : {}),
      };
      allBookmarks.push(enriched);
      return enriched;
    });

    const children = folder.children.map((child) =>
      convertFolder(child, folderSegments),
    );
    const totalBookmarkCount =
      bookmarks.length + children.reduce((acc, c) => acc + c.totalBookmarkCount, 0);

    const enrichedNode: EnrichedFolderNode = {
      path: folder.path,
      slug: folder.slug,
      title: folder.title,
      order: folder.order,
      ...(folder.description !== undefined ? { description: folder.description } : {}),
      ...(folder.introMarkdown !== undefined
        ? { introMarkdown: folder.introMarkdown }
        : {}),
      ...(introHtml !== undefined ? { introHtml } : {}),
      bookmarks,
      children,
      totalBookmarkCount,
    };

    if (folder.path) {
      flatFolders.push(enrichedNode);
    }
    return enrichedNode;
  }

  const root = convertFolder(tree.root, []);

  const usedTagSlugs = new Set<string>();
  const tags: TagSummary[] = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({
      tag,
      slug: slugifyTagForRoute(tag, usedTagSlugs),
      count,
    }));

  const usedUserSlugs = new Set<string>();
  const contributors: ContributorSummary[] = [...contributorUrls.entries()]
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .map(([username, urlSet]) => ({
      username,
      slug: slugifyTagForRoute(username, usedUserSlugs),
      count: urlSet.size,
    }));

  return { root, flatFolders, allBookmarks, tags, contributors };
}

export interface ValidationReport {
  valid: boolean;
  folderCount: number;
  bookmarkCount: number;
  errors: string[];
  warnings: string[];
}

export async function validateBookmarksRepo(options: {
  inputDir: string;
  configPath?: string;
  cwd?: string;
}): Promise<ValidationReport> {
  const cwd = options.cwd ?? process.cwd();
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const cfgRes = await loadGlyphrigConfig({
      configPath: options.configPath,
      cwd,
    });
    if (!cfgRes.configFound) {
      warnings.push('No glyphrig.config.yaml found; default settings will be used.');
    }
    try {
      await resolveTheme(cfgRes.config.theme.use, cwd);
    } catch (themeErr) {
      errors.push(themeErr instanceof Error ? themeErr.message : String(themeErr));
    }
    if (cfgRes.config.theme.customCss) {
      const cssPath = path.resolve(cwd, cfgRes.config.theme.customCss);
      try {
        await fs.access(cssPath);
      } catch {
        errors.push(`Configured theme.customCss file not found: ${cssPath}`);
      }
    }
    if (cfgRes.config.theme.customHead) {
      const headPath = path.resolve(cwd, cfgRes.config.theme.customHead);
      try {
        await fs.access(headPath);
      } catch {
        errors.push(`Configured theme.customHead file not found: ${headPath}`);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  let folderCount = 0;
  let bookmarkCount = 0;

  try {
    const files = await readBookmarkDirectory(path.resolve(cwd, options.inputDir));
    if (files.size === 0) {
      warnings.push(`No README.md bookmark files found under ${options.inputDir}.`);
    }
    const { tree } = parseBookmarkRepoFiles(files, 'bookmarks');

    function inspectFolder(folder: FolderNode): void {
      folderCount++;
      for (const bm of folder.bookmarks) {
        bookmarkCount++;
        const check = inspectUrlSafety(bm.url);
        if (!check.allowed) {
          warnings.push(
            `[${folder.path || 'root'}] "${bm.title}" (${bm.url}): ${check.detail ?? check.reason}`,
          );
        }
      }
      for (const child of folder.children) {
        inspectFolder(child);
      }
    }
    inspectFolder(tree.root);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    valid: errors.length === 0,
    folderCount,
    bookmarkCount,
    errors,
    warnings,
  };
}
