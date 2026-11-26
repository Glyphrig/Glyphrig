import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyAutoTagRules,
  inspectUrlSafety,
  mergeBookmarkEntries,
  normalizeUrl,
  normalizeUsername,
  parseBookmarkRepoFiles,
  serializeFolderMarkdown,
  slugifyFolderName,
  type AutoTagRule,
  type BookmarkEntry,
  type FolderNode,
} from '@glyphrig/core';
import { loadGlyphrigConfig } from './config.js';
import { readBookmarkDirectory } from './loader.js';

export type ImportFormat =
  | 'auto'
  | 'netscape'
  | 'raindrop'
  | 'pinboard'
  | 'pocket'
  | 'linkding'
  | 'karakeep';

const VALID_IMPORT_FORMATS = new Set<ImportFormat>([
  'auto',
  'netscape',
  'raindrop',
  'pinboard',
  'pocket',
  'linkding',
  'karakeep',
]);

export interface ImportedBookmarkRecord {
  title: string;
  url: string;
  folderSegments: string[];
  note?: string;
  tags: string[];
  added?: string;
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return '';
  }
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, '&');
}

function cleanSingleLineTitle(raw: string, fallbackUrl: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned || fallbackUrl;
}

function parseIsoOrUnixDate(raw?: string | number | null): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  if (/^\d{9,13}$/.test(s)) {
    const num = Number(s);
    const ms = s.length >= 12 ? num : num * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

function sanitizeImportedTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function splitTags(raw: string | unknown[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : raw.split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = sanitizeImportedTag(item);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const text = csv.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function parseHtmlTagAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(?:^|\s)([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs)) !== null) {
    const key = (m[1] ?? '').toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (key) {
      attrs[key] = decodeHtmlEntities(val);
    }
  }
  return attrs;
}

interface HtmlToken {
  type: 'open' | 'close' | 'text';
  tag?: string;
  attrs?: string;
  text?: string;
}

function tokenizeHtmlQuoteAware(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  let textStart = 0;
  const n = html.length;

  while (i < n) {
    if (html[i] !== '<') {
      i++;
      continue;
    }
    if (i > textStart) {
      tokens.push({ type: 'text', text: html.slice(textStart, i) });
    }
    if (html.startsWith('<!--', i)) {
      const endComment = html.indexOf('-->', i + 4);
      i = endComment === -1 ? n : endComment + 3;
      textStart = i;
      continue;
    }
    // Scan tag respecting quoted attribute values (e.g. SVG data-URI ICON attributes with >)
    let j = i + 1;
    let quote: '"' | "'" | null = null;
    while (j < n) {
      const ch = html[j]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= n) break;

    const rawTag = html.slice(i + 1, j).trim();
    const isClose = rawTag.startsWith('/');
    const nameMatch = rawTag.match(/^\/?\s*([a-zA-Z0-9!_-]+)([\s\S]*)$/);
    if (nameMatch && nameMatch[1]) {
      const tag = nameMatch[1].toLowerCase();
      if (isClose) {
        tokens.push({ type: 'close', tag });
      } else {
        tokens.push({ type: 'open', tag, attrs: nameMatch[2] ?? '' });
      }
    }
    i = j + 1;
    textStart = i;
  }

  if (textStart < n) {
    tokens.push({ type: 'text', text: html.slice(textStart) });
  }
  return tokens;
}

export function parseNetscapeHtml(html: string): ImportedBookmarkRecord[] {
  const tokens = tokenizeHtmlQuoteAware(html);
  const records: ImportedBookmarkRecord[] = [];
  const folderStack: string[] = [];
  let pendingFolderTitle: string | null = null;
  let lastRecord: ImportedBookmarkRecord | null = null;
  let inDd = false;

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]!;
    if (tok.type === 'text') {
      if (inDd && lastRecord) {
        const note = decodeHtmlEntities(tok.text ?? '').replace(/\s+/g, ' ').trim();
        if (note) {
          lastRecord.note = lastRecord.note ? `${lastRecord.note} ${note}` : note;
        }
      }
      continue;
    }

    const tag = tok.tag ?? '';

    if (tok.type === 'close') {
      if (tag === 'dl' || tag === 'ul') {
        folderStack.pop();
        pendingFolderTitle = null;
        lastRecord = null;
        inDd = false;
      } else if (tag === 'dd') {
        inDd = false;
      }
      continue;
    }

    // Open tags
    if (tag === 'dt' || tag === 'p' || tag === 'li') {
      inDd = false;
      continue;
    }

    if (tag === 'h3' || tag === 'h1') {
      inDd = false;
      lastRecord = null;
      let textBuf = '';
      while (idx + 1 < tokens.length) {
        const next = tokens[idx + 1]!;
        if (next.type === 'close' && next.tag === tag) {
          idx++;
          break;
        }
        if (next.type === 'open' && (next.tag === 'dl' || next.tag === 'ul' || next.tag === 'dt' || next.tag === 'a')) {
          break;
        }
        if (next.type === 'text') textBuf += next.text ?? '';
        idx++;
      }
      const title = decodeHtmlEntities(textBuf).replace(/\s+/g, ' ').trim();
      if (title && title.toLowerCase() !== 'bookmarks' && title.toLowerCase() !== 'bookmarks menu') {
        pendingFolderTitle = title;
      }
      continue;
    }

    if (tag === 'dl' || tag === 'ul') {
      inDd = false;
      lastRecord = null;
      if (pendingFolderTitle) {
        folderStack.push(pendingFolderTitle);
        pendingFolderTitle = null;
      } else {
        folderStack.push('');
      }
      continue;
    }

    if (tag === 'dd') {
      inDd = true;
      continue;
    }

    if (tag === 'a') {
      // Ignore anchor tags embedded inside a <dd> description
      if (inDd) {
        let linkText = '';
        while (idx + 1 < tokens.length) {
          const next = tokens[idx + 1]!;
          if (next.type === 'close' && next.tag === 'a') {
            idx++;
            break;
          }
          if (next.type === 'text') linkText += next.text ?? '';
          idx++;
        }
        if (lastRecord && linkText.trim()) {
          const clean = decodeHtmlEntities(linkText).replace(/\s+/g, ' ').trim();
          lastRecord.note = lastRecord.note ? `${lastRecord.note} ${clean}` : clean;
        }
        continue;
      }

      pendingFolderTitle = null;
      const attrs = parseHtmlTagAttributes(tok.attrs ?? '');
      const href = (attrs.href ?? '').trim();
      let titleBuf = '';
      while (idx + 1 < tokens.length) {
        const next = tokens[idx + 1]!;
        if (next.type === 'close' && next.tag === 'a') {
          idx++;
          break;
        }
        if (
          next.type === 'open' &&
          (next.tag === 'dt' || next.tag === 'dd' || next.tag === 'dl' || next.tag === 'a' || next.tag === 'h3' || next.tag === 'h1')
        ) {
          break;
        }
        if (next.type === 'text') titleBuf += next.text ?? '';
        idx++;
      }

      if (!href) continue;

      const title = cleanSingleLineTitle(decodeHtmlEntities(titleBuf), href);
      const added = parseIsoOrUnixDate(attrs.add_date ?? attrs.time_added);
      const tags = splitTags(attrs.tags);
      const segments = folderStack.filter(Boolean);

      const rec: ImportedBookmarkRecord = {
        title,
        url: href,
        folderSegments: segments,
        tags,
        ...(added ? { added } : {}),
      };
      records.push(rec);
      lastRecord = rec;
    }
  }

  return records;
}

export function parseRaindropCsv(csv: string): ImportedBookmarkRecord[] {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);

  const urlIdx = idx('url');
  const titleIdx = idx('title');
  const noteIdx = idx('note');
  const excerptIdx = idx('excerpt');
  const folderIdx = idx('folder');
  const tagsIdx = idx('tags');
  const createdIdx = idx('created');
  if (urlIdx === -1) return [];

  const records: ImportedBookmarkRecord[] = [];
  for (const row of rows.slice(1)) {
    const url = (row[urlIdx] ?? '').trim();
    if (!url) continue;
    const title = cleanSingleLineTitle(row[titleIdx] ?? '', url);
    const note =
      (row[noteIdx] ?? '').replace(/\s+/g, ' ').trim() ||
      (row[excerptIdx] ?? '').replace(/\s+/g, ' ').trim() ||
      undefined;
    const rawFolder = (row[folderIdx] ?? '').trim();
    const folderSegments = rawFolder
      ? rawFolder
          .split('/')
          .map((s) => s.trim())
          .filter((s) => Boolean(s) && s.toLowerCase() !== 'unsorted')
      : [];
    const tags = splitTags(row[tagsIdx]);
    const added = parseIsoOrUnixDate(row[createdIdx]);

    records.push({
      title,
      url,
      folderSegments,
      tags,
      ...(note ? { note } : {}),
      ...(added ? { added } : {}),
    });
  }
  return records;
}

export function parsePocketCsv(csv: string): ImportedBookmarkRecord[] {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  const urlIdx = headers.indexOf('url');
  const titleIdx = headers.indexOf('title');
  const timeIdx = headers.indexOf('time_added');
  const tagsIdx = headers.indexOf('tags');
  if (urlIdx === -1) return [];

  const records: ImportedBookmarkRecord[] = [];
  for (const row of rows.slice(1)) {
    const url = (row[urlIdx] ?? '').trim();
    if (!url) continue;
    const title = cleanSingleLineTitle(row[titleIdx] ?? '', url);
    const tags = splitTags((row[tagsIdx] ?? '').replace(/\|/g, ','));
    const added = parseIsoOrUnixDate(row[timeIdx]);
    records.push({
      title,
      url,
      folderSegments: [],
      tags,
      ...(added ? { added } : {}),
    });
  }
  return records;
}

export function parsePinboardJson(raw: unknown): ImportedBookmarkRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: ImportedBookmarkRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const url = typeof obj.href === 'string' ? obj.href.trim() : '';
    if (!url) continue;
    const title = cleanSingleLineTitle(
      typeof obj.description === 'string' ? obj.description : '',
      url,
    );
    const note =
      typeof obj.extended === 'string' && obj.extended.trim()
        ? obj.extended.replace(/\s+/g, ' ').trim()
        : undefined;
    const tags = splitTags(typeof obj.tags === 'string' ? obj.tags : undefined);
    const added = parseIsoOrUnixDate(typeof obj.time === 'string' ? obj.time : undefined);
    records.push({
      title,
      url,
      folderSegments: [],
      tags,
      ...(note ? { note } : {}),
      ...(added ? { added } : {}),
    });
  }
  return records;
}

export function parseLinkdingJson(raw: unknown): ImportedBookmarkRecord[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)
      ? ((raw as { results: unknown[] }).results)
      : [];
  const records: ImportedBookmarkRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!url) continue;
    const rawTitle =
      (typeof obj.title === 'string' && obj.title.trim()) ||
      (typeof obj.website_title === 'string' && obj.website_title.trim()) ||
      '';
    const title = cleanSingleLineTitle(rawTitle, url);
    const rawNote =
      (typeof obj.notes === 'string' && obj.notes.trim()) ||
      (typeof obj.description === 'string' && obj.description.trim()) ||
      (typeof obj.website_description === 'string' && obj.website_description.trim()) ||
      '';
    const note = rawNote ? rawNote.replace(/\s+/g, ' ').trim() : undefined;
    const tags = splitTags(Array.isArray(obj.tag_names) ? obj.tag_names : undefined);
    const added = parseIsoOrUnixDate(
      typeof obj.date_added === 'string' ? obj.date_added : undefined,
    );
    records.push({
      title,
      url,
      folderSegments: [],
      tags,
      ...(note ? { note } : {}),
      ...(added ? { added } : {}),
    });
  }
  return records;
}

export function parseKarakeepJson(raw: unknown): ImportedBookmarkRecord[] {
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as { bookmarks?: unknown }).bookmarks)
      ? ((raw as { bookmarks: unknown[] }).bookmarks)
      : [];

  const records: ImportedBookmarkRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const content =
      obj.content && typeof obj.content === 'object'
        ? (obj.content as Record<string, unknown>)
        : {};
    const url =
      (typeof content.url === 'string' && content.url.trim()) ||
      (typeof obj.url === 'string' && obj.url.trim()) ||
      '';
    if (!url) continue;
    const rawTitle =
      (typeof obj.title === 'string' && obj.title.trim()) ||
      (typeof content.title === 'string' && content.title.trim()) ||
      '';
    const title = cleanSingleLineTitle(rawTitle, url);
    const rawNote =
      (typeof obj.note === 'string' && obj.note.trim()) ||
      (typeof content.description === 'string' && content.description.trim()) ||
      '';
    const note = rawNote ? rawNote.replace(/\s+/g, ' ').trim() : undefined;
    const rawTags = Array.isArray(obj.tags)
      ? (obj.tags as unknown[])
          .map((t) =>
            typeof t === 'string'
              ? t
              : t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'
                ? (t as { name: string }).name
                : '',
          )
          .filter(Boolean)
      : [];
    const tags = splitTags(rawTags);
    const added = parseIsoOrUnixDate(
      typeof obj.createdAt === 'string' || typeof obj.createdAt === 'number'
        ? obj.createdAt
        : undefined,
    );

    records.push({
      title,
      url,
      folderSegments: [],
      tags,
      ...(note ? { note } : {}),
      ...(added ? { added } : {}),
    });
  }
  return records;
}

export function detectImportFormat(
  content: string,
  filePath?: string,
): Exclude<ImportFormat, 'auto'> {
  const stripped = content.replace(/^\uFEFF/, '').trim();
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';

  if (ext === '.csv') {
    const firstLine = stripped.split('\n')[0]?.toLowerCase() ?? '';
    return firstLine.includes('time_added') ? 'pocket' : 'raindrop';
  }

  if (stripped.startsWith('{') || stripped.startsWith('[') || ext === '.json') {
    try {
      const parsed = JSON.parse(stripped) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.bookmarks)) return 'karakeep';
        if (Array.isArray(obj.results)) return 'linkding';
      }
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0]) {
        const sample = parsed[0] as Record<string, unknown>;
        if ('href' in sample) return 'pinboard';
        if ('content' in sample) return 'karakeep';
        if ('tag_names' in sample || 'date_added' in sample) return 'linkding';
      }
      return 'pinboard';
    } catch {
      // fall through
    }
  }

  const firstLine = stripped.split('\n')[0]?.toLowerCase() ?? '';
  if (
    !stripped.startsWith('<') &&
    firstLine.includes(',') &&
    (firstLine.includes('url') || firstLine.includes('time_added'))
  ) {
    return firstLine.includes('time_added') ? 'pocket' : 'raindrop';
  }

  if (/<(!doctype\s+netscape-bookmark|dl|a\s+href=)/i.test(stripped) || ext === '.html' || ext === '.htm') {
    return 'netscape';
  }

  if (stripped.includes(',')) {
    return firstLine.includes('time_added') ? 'pocket' : 'raindrop';
  }

  return 'netscape';
}

export function parseImportedBookmarks(
  content: string,
  format: ImportFormat = 'auto',
  filePath?: string,
): { format: Exclude<ImportFormat, 'auto'>; records: ImportedBookmarkRecord[] } {
  if (!VALID_IMPORT_FORMATS.has(format)) {
    throw new Error(
      `Unsupported import format "${format}". Expected one of: auto, netscape, raindrop, pinboard, pocket, linkding, karakeep.`,
    );
  }
  const cleanContent = content.replace(/^\uFEFF/, '');
  const resolved = format === 'auto' ? detectImportFormat(cleanContent, filePath) : format;
  switch (resolved) {
    case 'netscape':
      return { format: 'netscape', records: parseNetscapeHtml(cleanContent) };
    case 'raindrop':
      return { format: 'raindrop', records: parseRaindropCsv(cleanContent) };
    case 'pocket':
      return {
        format: 'pocket',
        records: cleanContent.trim().startsWith('<')
          ? parseNetscapeHtml(cleanContent)
          : parsePocketCsv(cleanContent),
      };
    case 'pinboard':
      return { format: 'pinboard', records: parsePinboardJson(JSON.parse(cleanContent)) };
    case 'linkding':
      return { format: 'linkding', records: parseLinkdingJson(JSON.parse(cleanContent)) };
    case 'karakeep':
      return { format: 'karakeep', records: parseKarakeepJson(JSON.parse(cleanContent)) };
  }
}

export interface ImportBookmarksOptions {
  sourceFile: string;
  inputDir: string;
  configPath?: string;
  cwd?: string;
  format?: ImportFormat;
  targetFolder?: string;
  user?: string;
  dryRun?: boolean;
}

export interface ImportBookmarksResult {
  detectedFormat: Exclude<ImportFormat, 'auto'>;
  totalParsed: number;
  added: number;
  merged: number;
  skippedUnsafe: number;
  filesWritten: string[];
}

export async function importBookmarksFromFile(
  options: ImportBookmarksOptions,
): Promise<ImportBookmarksResult> {
  const cwd = options.cwd ?? process.cwd();
  const sourcePath = path.resolve(cwd, options.sourceFile);
  const inputDir = path.resolve(cwd, options.inputDir);
  const raw = await fs.readFile(sourcePath, 'utf8');

  const { format: detectedFormat, records } = parseImportedBookmarks(
    raw,
    options.format ?? 'auto',
    sourcePath,
  );

  let autoTagRules: AutoTagRule[] = [];
  try {
    const cfgRes = await loadGlyphrigConfig({ configPath: options.configPath, cwd });
    autoTagRules = cfgRes.config.enrichment.autoTagRules ?? [];
  } catch {
    // Allow importing before glyphrig.config.yaml exists
  }

  let existingFiles = new Map<string, string>();
  try {
    existingFiles = await readBookmarkDirectory(inputDir);
  } catch (err) {
    const isNotFound =
      (err as NodeJS.ErrnoException)?.code === 'ENOENT' ||
      (err instanceof Error && err.message.startsWith('Bookmarks directory not found:'));
    if (!isNotFound) {
      throw err;
    }
    if (!options.dryRun) {
      await fs.mkdir(inputDir, { recursive: true });
    }
  }

  const parsedRepo = parseBookmarkRepoFiles(existingFiles, 'bookmarks');
  const folderMap = new Map<string, FolderNode>();
  // Case-insensitive lookup prevents overwriting existing mixed-case folders on macOS/Windows
  const folderMapLower = new Map<string, FolderNode>();

  function indexFolders(node: FolderNode): void {
    folderMap.set(node.path, node);
    folderMapLower.set(node.path.toLowerCase(), node);
    for (const child of node.children) {
      indexFolders(child);
    }
  }
  indexFolders(parsedRepo.tree.root);

  const modifiedFolders = new Set<FolderNode>();

  const ensureFolder = (segments: string[]): FolderNode => {
    let current = parsedRepo.tree.root;
    for (const rawTitle of segments) {
      const slug = slugifyFolderName(rawTitle);
      const candidatePath = current.path ? `${current.path}/${slug}` : slug;
      let existing =
        folderMap.get(candidatePath) ?? folderMapLower.get(candidatePath.toLowerCase());
      if (!existing) {
        existing = {
          path: candidatePath,
          slug,
          title: rawTitle.trim() || slug,
          order: current.children.length,
          bookmarks: [],
          children: [],
        };
        current.children.push(existing);
        folderMap.set(existing.path, existing);
        folderMapLower.set(existing.path.toLowerCase(), existing);
      }
      current = existing;
    }
    return current;
  };

  const baseTargetSegments = options.targetFolder
    ? options.targetFolder
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const cleanUser = options.user ? normalizeUsername(options.user) : '';
  const today = new Date().toISOString().slice(0, 10);

  let added = 0;
  let merged = 0;
  let skippedUnsafe = 0;

  for (const rec of records) {
    const safety = inspectUrlSafety(rec.url);
    if (!safety.allowed) {
      skippedUnsafe++;
      continue;
    }
    const cleanUrl = safety.cleanedUrl;
    const normUrl = normalizeUrl(cleanUrl, false);
    const folder = ensureFolder([...baseTargetSegments, ...rec.folderSegments]);
    const tags = applyAutoTagRules({ url: cleanUrl, tags: rec.tags }, autoTagRules);

    const incoming: BookmarkEntry = {
      title: cleanSingleLineTitle(rec.title, cleanUrl),
      url: cleanUrl,
      normalizedUrl: normUrl,
      added: rec.added || today,
      ...(rec.note ? { note: rec.note } : {}),
      tags,
      ...(cleanUser ? { savedBy: [cleanUser] } : {}),
      order: folder.bookmarks.length,
    };

    const existingIdx = folder.bookmarks.findIndex((b) => b.normalizedUrl === normUrl);
    if (existingIdx !== -1) {
      folder.bookmarks[existingIdx] = mergeBookmarkEntries(
        folder.bookmarks[existingIdx]!,
        incoming,
      );
      merged++;
    } else {
      folder.bookmarks.push(incoming);
      added++;
    }
    modifiedFolders.add(folder);
  }

  const filesWritten: string[] = [];
  for (const folder of modifiedFolders) {
    const repoFilePath = folder.path
      ? `bookmarks/${folder.path}/README.md`
      : 'bookmarks/README.md';
    const content = serializeFolderMarkdown(folder, parsedRepo.rawDocs.get(folder.path));
    if (existingFiles.get(repoFilePath) === content) continue;
    const relInsideBookmarks = repoFilePath.replace(/^bookmarks\/?/, '');
    const destAbs = path.join(inputDir, relInsideBookmarks);
    filesWritten.push(destAbs);
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.writeFile(destAbs, content, 'utf8');
    }
  }

  return {
    detectedFormat,
    totalParsed: records.length,
    added,
    merged,
    skippedUnsafe,
    filesWritten,
  };
}
