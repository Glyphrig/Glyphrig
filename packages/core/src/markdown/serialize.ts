import YAML from 'yaml';
import type { BookmarkEntry, BookmarkTree, FolderNode } from '../types.js';
import {
  mergeBookmarkEntries,
  mergeContributorNotes,
  normalizeContributorNotes,
  normalizeUserList,
  type MarkdownBlock,
  type ParsedFolderDocument,
} from './parse.js';
import { folderPathToFilePath, normalizeRepoRootDir } from './slug.js';

function escapeMarkdownTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(/([\\[\]])/g, '\\$1');
}

function sanitizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function sanitizeCommentToken(raw: string): string {
  return raw.trim().replace(/\s+/g, '').replace(/-->/g, '');
}

function formatMarkdownUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let depth = 0;
  let balanced = true;
  for (const ch of trimmed) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) {
        balanced = false;
        break;
      }
    }
  }
  if (depth !== 0) balanced = false;

  if (!balanced || /\s/.test(trimmed)) {
    const safe = trimmed.replace(/\s/g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E');
    return `<${safe}>`;
  }
  return trimmed;
}

export function formatBookmarkLine(entry: BookmarkEntry): string {
  const safeTitle = escapeMarkdownTitle(entry.title || entry.url);
  const safeUrl = formatMarkdownUrl(entry.url);
  const parts: string[] = [`- [${safeTitle}](${safeUrl})`];

  if (entry.note && entry.note.trim()) {
    parts.push(`— ${entry.note.trim().replace(/\s+/g, ' ')}`);
  }

  if (entry.tags && entry.tags.length > 0) {
    const cleanTags = [...new Set(entry.tags.map(sanitizeTag).filter(Boolean))];
    if (cleanTags.length > 0) {
      parts.push(cleanTags.map((t) => `\`#${t}\``).join(' '));
    }
  }

  const metaParts: string[] = [];
  if (entry.added && entry.added.trim()) {
    const clean = sanitizeCommentToken(entry.added);
    if (clean) metaParts.push(`added=${clean}`);
  }
  const cleanBy = normalizeUserList(entry.savedBy);
  if (cleanBy.length > 0) {
    metaParts.push(`by=${cleanBy.join(',')}`);
  }
  if (entry.archivedAt && entry.archivedAt.trim()) {
    const clean = sanitizeCommentToken(entry.archivedAt);
    if (clean) metaParts.push(`archived=${clean}`);
  }
  if (entry.archiveUrl && entry.archiveUrl.trim()) {
    const clean = sanitizeCommentToken(entry.archiveUrl);
    if (clean) metaParts.push(`archive=${clean}`);
  }
  if (metaParts.length > 0) {
    parts.push(`<!-- glyphrig: ${metaParts.join(' ')} -->`);
  }

  return parts.join(' ');
}

export function formatBookmarkLines(entry: BookmarkEntry): string[] {
  const lines = [formatBookmarkLine(entry)];
  const notes = normalizeContributorNotes(entry.contributorNotes);
  if (notes) {
    for (const [user, text] of Object.entries(notes)) {
      lines.push(`  - **@${user}**: ${text}`);
    }
  }
  return lines;
}

function buildFrontmatter(
  folder: FolderNode,
  existingDoc?: ParsedFolderDocument,
): string {
  const fm: Record<string, unknown> = {};
  if (existingDoc) {
    for (const [key, value] of Object.entries(existingDoc.extraFrontmatter)) {
      if (value !== undefined) {
        fm[key] = value;
      }
    }
  }
  fm.title = folder.title;
  fm.order = folder.order;
  if (folder.description !== undefined && folder.description !== '') {
    fm.description = folder.description;
  } else {
    delete fm.description;
  }
  const maintainers = normalizeUserList(folder.maintainers);
  if (maintainers.length > 0) {
    fm.maintainers = maintainers;
  } else {
    delete fm.maintainers;
  }
  const yamlBody = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBody}\n---`;
}

function mergeBookmarkMetadata(
  incoming: BookmarkEntry,
  existing?: BookmarkEntry,
): BookmarkEntry {
  if (!existing) {
    return incoming;
  }
  const contributorNotes = mergeContributorNotes(
    existing.contributorNotes,
    incoming.contributorNotes,
  );
  const archiveUrl = incoming.archiveUrl ?? existing.archiveUrl;
  const mergedTags = [...new Set([...existing.tags, ...incoming.tags])];
  return {
    ...incoming,
    note: incoming.note !== undefined ? incoming.note : existing.note,
    ...(contributorNotes ? { contributorNotes } : {}),
    tags: mergedTags,
    added: incoming.added !== undefined ? incoming.added : existing.added,
    savedBy: incoming.savedBy !== undefined ? incoming.savedBy : existing.savedBy,
    archivedAt: incoming.archivedAt !== undefined ? incoming.archivedAt : existing.archivedAt,
    ...(archiveUrl ? { archiveUrl } : {}),
  };
}

function hasInterspersedProseBetweenBookmarks(blocks: MarkdownBlock[]): boolean {
  let seenFirstBookmark = false;
  let seenNonBlankProseAfterBookmark = false;
  for (const block of blocks) {
    if (block.type === 'bookmark') {
      if (seenNonBlankProseAfterBookmark) {
        return true;
      }
      seenFirstBookmark = true;
    } else if (seenFirstBookmark && block.type === 'prose') {
      seenNonBlankProseAfterBookmark = true;
    }
  }
  return false;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }
  return out;
}

function collapseExcessBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const isBlank = line === '';
    if (isBlank && prevBlank) {
      continue;
    }
    out.push(line);
    prevBlank = isBlank;
  }
  while (out.length > 0 && out[0] === '') {
    out.shift();
  }
  return trimTrailingBlankLines(out);
}

export function serializeFolderMarkdown(
  folder: FolderNode,
  existingDoc?: ParsedFolderDocument,
  options: { preserveExistingMetadata?: boolean } = {},
): string {
  const preserveExistingMetadata = options.preserveExistingMetadata ?? true;
  const frontmatter = buildFrontmatter(folder, existingDoc);
  const sortedBookmarks = [...folder.bookmarks].sort((a, b) => a.order - b.order);

  // Build queue of existing bookmarks by normalizedUrl to carry over rich metadata
  const existingByUrl = new Map<string, BookmarkEntry[]>();
  if (preserveExistingMetadata && existingDoc) {
    for (const item of existingDoc.bookmarks) {
      const list = existingByUrl.get(item.normalizedUrl) ?? [];
      list.push(item);
      existingByUrl.set(item.normalizedUrl, list);
    }
  }

  const enrichedBookmarks = sortedBookmarks.map((bm) => {
    if (!preserveExistingMetadata) return bm;
    const matches = existingByUrl.get(bm.normalizedUrl);
    const matched = matches && matches.length > 0 ? matches.shift() : undefined;
    return mergeBookmarkMetadata(bm, matched);
  });

  let bodyLines: string[];

  if (!existingDoc || existingDoc.blocks.length === 0) {
    bodyLines = [];
    if (folder.introMarkdown && folder.introMarkdown.trim()) {
      bodyLines.push(...folder.introMarkdown.trim().split('\n'));
      if (enrichedBookmarks.length > 0) {
        bodyLines.push('');
      }
    }
    for (const bm of enrichedBookmarks) {
      bodyLines.push(...formatBookmarkLines(bm));
    }
  } else if (hasInterspersedProseBetweenBookmarks(existingDoc.blocks)) {
    // Hand-grouped sections exist: update matching bookmarks in place and append new ones
    const remainingByUrl = new Map<string, BookmarkEntry[]>();
    for (const bm of enrichedBookmarks) {
      const list = remainingByUrl.get(bm.normalizedUrl) ?? [];
      list.push(bm);
      remainingByUrl.set(bm.normalizedUrl, list);
    }

    bodyLines = [];
    let lastBookmarkOutIdx = -1;

    for (const block of existingDoc.blocks) {
      if (block.type !== 'bookmark') {
        bodyLines.push(block.raw);
        continue;
      }
      const list = remainingByUrl.get(block.entry.normalizedUrl);
      const nextBm = list && list.length > 0 ? list.shift() : undefined;
      if (nextBm) {
        bodyLines.push(...formatBookmarkLines(nextBm));
        lastBookmarkOutIdx = bodyLines.length - 1;
      }
    }

    const unplaced: string[] = [];
    for (const bm of enrichedBookmarks) {
      const remaining = remainingByUrl.get(bm.normalizedUrl);
      if (remaining && remaining.length > 0 && remaining[0] === bm) {
        remaining.shift();
        unplaced.push(...formatBookmarkLines(bm));
      }
    }

    if (unplaced.length > 0) {
      if (lastBookmarkOutIdx !== -1) {
        bodyLines.splice(lastBookmarkOutIdx + 1, 0, ...unplaced);
      } else {
        if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] !== '') {
          bodyLines.push('');
        }
        bodyLines.push(...unplaced);
      }
    }
    bodyLines = collapseExcessBlankLines(bodyLines);
  } else {
    // Standard structure: leading prose -> contiguous bookmark list -> optional trailing prose
    const firstBmIdx = existingDoc.blocks.findIndex((b) => b.type === 'bookmark');
    const lastBmIdx = existingDoc.blocks.reduce(
      (acc, b, i) => (b.type === 'bookmark' ? i : acc),
      -1,
    );

    const beforeLines =
      firstBmIdx === -1
        ? existingDoc.blocks.map((b) => b.raw)
        : existingDoc.blocks.slice(0, firstBmIdx).map((b) => b.raw);
    const afterLines =
      lastBmIdx === -1
        ? []
        : existingDoc.blocks.slice(lastBmIdx + 1).map((b) => b.raw);

    const cleanBefore = trimTrailingBlankLines(beforeLines);
    const cleanAfter = trimTrailingBlankLines(afterLines);
    while (cleanAfter.length > 0 && cleanAfter[0] === '') {
      cleanAfter.shift();
    }

    bodyLines = [...cleanBefore];
    if (cleanBefore.length > 0 && (enrichedBookmarks.length > 0 || cleanAfter.length > 0)) {
      bodyLines.push('');
    }
    for (const bm of enrichedBookmarks) {
      bodyLines.push(...formatBookmarkLines(bm));
    }
    if (cleanAfter.length > 0) {
      if (enrichedBookmarks.length > 0) {
        bodyLines.push('');
      }
      bodyLines.push(...cleanAfter);
    }
    bodyLines = collapseExcessBlankLines(bodyLines);
  }

  if (bodyLines.length === 0) {
    return `${frontmatter}\n`;
  }
  return `${frontmatter}\n\n${bodyLines.join('\n')}\n`;
}

export function serializeBookmarkTree(
  tree: BookmarkTree,
  rootDir = 'bookmarks',
  existingDocs?: Map<string, ParsedFolderDocument>,
  options: { preserveExistingMetadata?: boolean } = {},
): Map<string, string> {
  const cleanRoot = normalizeRepoRootDir(rootDir);
  const files = new Map<string, string>();

  function walk(folder: FolderNode): void {
    const filePath = folderPathToFilePath(cleanRoot, folder.path);
    const existing = existingDocs?.get(folder.path);
    files.set(filePath, serializeFolderMarkdown(folder, existing, options));

    const sortedChildren = [...folder.children].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.slug.localeCompare(b.slug);
    });
    sortedChildren.forEach((child, idx) => {
      walk({ ...child, order: idx });
    });
  }

  walk(tree.root);
  return files;
}

export function diffRepoFiles(
  nextFiles: Map<string, string>,
  previousFiles: Map<string, string>,
): { upserts: Map<string, string>; deletes: string[] } {
  const upserts = new Map<string, string>();
  const deletes: string[] = [];

  for (const [path, content] of nextFiles.entries()) {
    const prev = previousFiles.get(path);
    if (prev !== content) {
      upserts.set(path, content);
    }
  }

  for (const prevPath of previousFiles.keys()) {
    if (!nextFiles.has(prevPath)) {
      deletes.push(prevPath);
    }
  }

  deletes.sort();
  return { upserts, deletes };
}

export function serializeArchiveDocument(
  folderPath: string,
  folderTitle: string,
  entries: BookmarkEntry[],
  existingDoc?: ParsedFolderDocument,
): string {
  const byUrl = new Map<string, BookmarkEntry>();
  for (const item of entries) {
    const prev = byUrl.get(item.normalizedUrl);
    if (!prev) {
      byUrl.set(item.normalizedUrl, { ...item, tags: [...item.tags] });
    } else {
      const merged = mergeBookmarkEntries(prev, item);
      const archivedAt =
        [prev.archivedAt, item.archivedAt].filter(Boolean).sort().pop() ??
        prev.archivedAt ??
        item.archivedAt;
      byUrl.set(item.normalizedUrl, {
        ...merged,
        ...(archivedAt ? { archivedAt } : {}),
      });
    }
  }

  const deduped = [...byUrl.values()].sort((a, b) => {
    const da = a.archivedAt ?? '0000-00-00';
    const db = b.archivedAt ?? '0000-00-00';
    if (da !== db) return db.localeCompare(da);
    return a.title.localeCompare(b.title);
  });

  const fm: Record<string, unknown> = {
    ...(existingDoc?.extraFrontmatter ?? {}),
    title: `${folderTitle} (Archived)`,
    archived: true,
  };
  delete fm.order;
  const frontmatter = `---\n${YAML.stringify(fm, { lineWidth: 0 }).trimEnd()}\n---`;

  const introLines: string[] = [];
  if (existingDoc) {
    for (const block of existingDoc.blocks) {
      if (block.type === 'bookmark') break;
      introLines.push(block.raw);
    }
  }
  const cleanIntro = collapseExcessBlankLines(introLines);
  const bodyParts: string[] =
    cleanIntro.length > 0
      ? cleanIntro
      : [
          `Archived bookmarks removed from \`${folderPath ? `${folderPath}/README.md` : 'README.md'}\`.`,
        ];

  if (deduped.length > 0) {
    bodyParts.push('');
    for (const item of deduped) {
      bodyParts.push(...formatBookmarkLines(item));
    }
  }

  return `${frontmatter}\n\n${bodyParts.join('\n')}\n`;
}
