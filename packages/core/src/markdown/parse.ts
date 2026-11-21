import YAML from 'yaml';
import { normalizeUrl } from '../safety/sanitize.js';
import type { BookmarkEntry, BookmarkTree, FolderNode } from '../types.js';
import {
  archiveFilePathToFolderPath,
  filePathToFolderPath,
  normalizeRepoRootDir,
} from './slug.js';

export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '');
}

export function normalizeUserList(users?: string[]): string[] {
  if (!users || users.length === 0) return [];
  const set = new Set<string>();
  for (const u of users) {
    const clean = normalizeUsername(u);
    if (clean) set.add(clean);
  }
  return [...set].sort();
}

export function mergeNotes(existing?: string, incoming?: string): string | undefined {
  const a = existing?.trim().replace(/\s+/g, ' ');
  const b = incoming?.trim().replace(/\s+/g, ' ');
  if (!a) return b || undefined;
  if (!b) return a || undefined;
  if (a.toLowerCase() === b.toLowerCase()) return a;
  const partsA = a.split(/\s+\/\s+/).map((p) => p.toLowerCase());
  const partsB = b.split(/\s+\/\s+/);
  const additions = partsB.filter((seg) => !partsA.includes(seg.toLowerCase()));
  if (additions.length === 0) return a;
  return `${a} / ${additions.join(' / ')}`;
}

export function mergeBookmarkEntries(
  primary: BookmarkEntry,
  incoming: BookmarkEntry,
): BookmarkEntry {
  const savedBy = normalizeUserList([
    ...(primary.savedBy ?? []),
    ...(incoming.savedBy ?? []),
  ]);
  const tagSet = new Set<string>();
  const tags: string[] = [];
  for (const t of [...primary.tags, ...incoming.tags]) {
    const clean = t.trim().replace(/^#+/, '').toLowerCase();
    if (clean && !tagSet.has(clean)) {
      tagSet.add(clean);
      tags.push(clean);
    }
  }
  const addedCandidates = [primary.added, incoming.added].filter(
    (d): d is string => Boolean(d && d.trim()),
  );
  addedCandidates.sort();
  const note = mergeNotes(primary.note, incoming.note);

  return {
    ...primary,
    ...(addedCandidates[0] ? { added: addedCandidates[0] } : {}),
    ...(note !== undefined ? { note } : {}),
    tags,
    ...(savedBy.length > 0 ? { savedBy } : {}),
  };
}

export type MarkdownBlock =
  | { type: 'prose'; raw: string }
  | { type: 'blank'; raw: string }
  | { type: 'bookmark'; raw: string; entry: BookmarkEntry };

export interface ParsedFolderDocument {
  folderPath: string;
  title?: string;
  order?: number;
  description?: string;
  extraFrontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  introMarkdown?: string;
  blocks: MarkdownBlock[];
  bookmarks: BookmarkEntry[];
}

function unescapeMarkdownTitle(raw: string): string {
  return raw.replace(/\\([\\[\]])/g, '$1');
}

function parseGlyphrigComment(rawComment: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = rawComment.match(/^<!--\s*glyphrig:\s*(.*?)\s*-->$/i);
  if (!match) {
    return result;
  }
  const body = match[1] ?? '';
  const tokenRegex = /([a-zA-Z0-9_-]+)=([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(body)) !== null) {
    if (m[1] && m[2]) {
      result[m[1]] = m[2];
    }
  }
  return result;
}

export function parseBookmarkLine(line: string, order = 0): BookmarkEntry | null {
  const bulletMatch = line.match(/^\s*[-*]\s+\[/);
  if (!bulletMatch) {
    return null;
  }

  let idx = bulletMatch[0].length;
  let rawTitle = '';
  let titleClosed = false;

  while (idx < line.length) {
    const ch = line[idx];
    if (ch === '\\' && idx + 1 < line.length) {
      rawTitle += ch + line[idx + 1];
      idx += 2;
      continue;
    }
    if (ch === ']') {
      titleClosed = true;
      idx++;
      break;
    }
    rawTitle += ch;
    idx++;
  }

  if (!titleClosed || line[idx] !== '(') {
    return null;
  }

  idx++; // skip '('
  let rawUrl = '';
  let urlClosed = false;

  if (line[idx] === '<') {
    idx++;
    while (idx < line.length) {
      const ch = line[idx];
      if (ch === '>') {
        idx++;
        if (line[idx] === ')') {
          urlClosed = true;
          idx++;
        }
        break;
      }
      rawUrl += ch;
      idx++;
    }
  } else {
    let parenDepth = 1;
    while (idx < line.length) {
      const ch = line[idx];
      if (ch === '\\' && idx + 1 < line.length) {
        rawUrl += line[idx + 1];
        idx += 2;
        continue;
      }
      if (ch === '(') {
        parenDepth++;
        rawUrl += ch;
        idx++;
        continue;
      }
      if (ch === ')') {
        parenDepth--;
        if (parenDepth === 0) {
          urlClosed = true;
          idx++;
          break;
        }
        rawUrl += ch;
        idx++;
        continue;
      }
      if (/\s/.test(ch ?? '')) {
        break;
      }
      rawUrl += ch;
      idx++;
    }
  }

  const trimmedUrl = rawUrl.trim();
  if (!urlClosed || !trimmedUrl) {
    return null;
  }

  let tail = line.slice(idx).trim();
  let added: string | undefined;
  let savedBy: string[] = [];
  let archivedAt: string | undefined;

  const commentMatch = tail.match(/(<!--\s*glyphrig:\s*.*?-->)\s*$/i);
  if (commentMatch && commentMatch[1]) {
    const meta = parseGlyphrigComment(commentMatch[1]);
    if (meta.added) {
      added = meta.added;
    }
    if (meta.by) {
      savedBy = normalizeUserList(meta.by.split(','));
    }
    if (meta.archived) {
      archivedAt = meta.archived;
    }
    tail = tail.slice(0, commentMatch.index).trim();
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();
  const tagRegex = /`#([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)`/g;
  const tailWithoutTags = tail
    .replace(tagRegex, (_full, tag: string) => {
      const clean = tag.toLowerCase();
      if (!seenTags.has(clean)) {
        seenTags.add(clean);
        tags.push(clean);
      }
      return ' ';
    })
    .trim();

  let note: string | undefined;
  if (tailWithoutTags) {
    const cleanedNote = tailWithoutTags
      .replace(/^(?:—|–|--|-)\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanedNote) {
      note = cleanedNote;
    }
  }

  const title = unescapeMarkdownTitle(rawTitle).trim() || trimmedUrl;
  return {
    title,
    url: trimmedUrl,
    normalizedUrl: normalizeUrl(trimmedUrl, false),
    ...(added ? { added } : {}),
    ...(note ? { note } : {}),
    tags,
    ...(savedBy.length > 0 ? { savedBy } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    order,
  };
}

function splitFrontmatter(raw: string): {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { hasFrontmatter: false, frontmatter: {}, body: normalized };
  }

  if (normalized.startsWith('---\n---\n') || normalized === '---\n---') {
    const rest = normalized.slice('---\n---'.length).replace(/^\n/, '');
    return { hasFrontmatter: true, frontmatter: {}, body: rest };
  }

  const endMarker = normalized.indexOf('\n---\n', 4);
  const eofMarker = endMarker === -1 && normalized.endsWith('\n---') ? normalized.length - 4 : -1;
  const closeIdx = endMarker !== -1 ? endMarker : eofMarker;

  if (closeIdx === -1) {
    return { hasFrontmatter: false, frontmatter: {}, body: normalized };
  }

  const yamlText = normalized.slice(4, closeIdx);
  const body =
    endMarker !== -1 ? normalized.slice(closeIdx + '\n---\n'.length) : '';

  try {
    const parsed = YAML.parse(yamlText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        hasFrontmatter: true,
        frontmatter: parsed as Record<string, unknown>,
        body,
      };
    }
  } catch {
    // Tolerate malformed frontmatter gracefully by treating it as body prose.
  }

  return { hasFrontmatter: false, frontmatter: {}, body: normalized };
}

export function parseFolderMarkdown(
  content: string,
  folderPath: string,
): ParsedFolderDocument {
  const { hasFrontmatter, frontmatter, body } = splitFrontmatter(content);
  const extraFrontmatter: Record<string, unknown> = {};

  let title: string | undefined;
  let order: number | undefined;
  let description: string | undefined;

  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'title' && typeof value === 'string') {
      title = value;
    } else if (key === 'order' && typeof value === 'number' && Number.isFinite(value)) {
      order = value;
    } else if (key === 'description' && typeof value === 'string') {
      description = value;
    } else {
      extraFrontmatter[key] = value;
    }
  }

  const lines = body.split('\n');
  // Remove single trailing empty element produced by trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const blocks: MarkdownBlock[] = [];
  const bookmarks: BookmarkEntry[] = [];
  let inCodeFence = false;
  let bookmarkOrder = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      blocks.push({ type: 'prose', raw: line });
      continue;
    }

    if (!inCodeFence && trimmed === '') {
      blocks.push({ type: 'blank', raw: line });
      continue;
    }

    if (!inCodeFence) {
      const entry = parseBookmarkLine(line, bookmarkOrder);
      if (entry) {
        bookmarkOrder++;
        bookmarks.push(entry);
        blocks.push({ type: 'bookmark', raw: line, entry });
        continue;
      }
    }

    blocks.push({ type: 'prose', raw: line });
  }

  // Extract leading prose before the first bookmark as introMarkdown for site rendering
  const introLines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'bookmark') {
      break;
    }
    introLines.push(block.raw);
  }
  const introTrimmed = introLines.join('\n').trim();

  return {
    folderPath,
    ...(title !== undefined ? { title } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(description !== undefined ? { description } : {}),
    extraFrontmatter,
    hasFrontmatter,
    ...(introTrimmed ? { introMarkdown: introTrimmed } : {}),
    blocks,
    bookmarks,
  };
}

function defaultFolderTitleFromSlug(slug: string): string {
  if (!slug) {
    return 'Bookmarks';
  }
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sortFolders(folder: FolderNode): void {
  folder.children.sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.slug.localeCompare(b.slug);
  });
  for (const child of folder.children) {
    sortFolders(child);
  }
}

export function parseBookmarkRepoFiles(
  files: Map<string, string>,
  rootDir = 'bookmarks',
): {
  tree: BookmarkTree;
  rawDocs: Map<string, ParsedFolderDocument>;
} {
  const cleanRoot = normalizeRepoRootDir(rootDir);
  const rawDocs = new Map<string, ParsedFolderDocument>();
  const folderMap = new Map<string, FolderNode>();

  const ensureFolder = (folderPath: string): FolderNode => {
    const existing = folderMap.get(folderPath);
    if (existing) {
      return existing;
    }
    const parts = folderPath ? folderPath.split('/') : [];
    const slug = parts[parts.length - 1] ?? '';
    const node: FolderNode = {
      path: folderPath,
      slug,
      title: defaultFolderTitleFromSlug(slug),
      order: Number.MAX_SAFE_INTEGER,
      bookmarks: [],
      children: [],
    };
    folderMap.set(folderPath, node);

    if (folderPath !== '') {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureFolder(parentPath);
      parent.children.push(node);
    }
    return node;
  };

  // Root folder always exists
  const rootNode = ensureFolder('');
  rootNode.order = 0;

  const sortedPaths = [...files.keys()].sort();
  for (const filePath of sortedPaths) {
    const folderPath = filePathToFolderPath(cleanRoot, filePath);
    if (folderPath === null) {
      continue;
    }
    const content = files.get(filePath) ?? '';
    const doc = parseFolderMarkdown(content, folderPath);
    rawDocs.set(folderPath, doc);

    const node = ensureFolder(folderPath);
    const parts = folderPath ? folderPath.split('/') : [];
    const slug = parts[parts.length - 1] ?? '';
    node.title = doc.title ?? defaultFolderTitleFromSlug(slug);
    node.order = doc.order ?? 0;
    if (doc.description !== undefined) {
      node.description = doc.description;
    }
    if (doc.introMarkdown !== undefined) {
      node.introMarkdown = doc.introMarkdown;
    }
    node.bookmarks = doc.bookmarks;
  }

  // Assign deterministic order to any virtual folders missing explicit README.md
  function normalizeOrders(folder: FolderNode): void {
    sortFolders(folder);
    folder.children.forEach((child, index) => {
      if (child.order === Number.MAX_SAFE_INTEGER) {
        child.order = index;
      }
      normalizeOrders(child);
    });
  }
  normalizeOrders(rootNode);

  return {
    tree: { root: rootNode },
    rawDocs,
  };
}

export function parseArchiveRepoFiles(
  files: Map<string, string>,
  rootDir = 'bookmarks',
): Map<string, ParsedFolderDocument> {
  const cleanRoot = normalizeRepoRootDir(rootDir);
  const docs = new Map<string, ParsedFolderDocument>();
  const sortedPaths = [...files.keys()].sort();
  for (const filePath of sortedPaths) {
    const folderPath = archiveFilePathToFolderPath(cleanRoot, filePath);
    if (folderPath === null) {
      continue;
    }
    const content = files.get(filePath) ?? '';
    docs.set(folderPath, parseFolderMarkdown(content, folderPath));
  }
  return docs;
}
