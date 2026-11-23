import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Marked, Renderer, type Tokens } from 'marked';
import { BASE_PATH, DOC_ENTRIES, REPO_URL, type DocEntry } from './site';

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface RenderedDoc {
  slug: string;
  filename: string;
  title: string;
  summary: string;
  badge: string;
  html: string;
  toc: TocItem[];
}

const DOC_SLUG_BY_FILE = new Map<string, string>(
  DOC_ENTRIES.map((entry) => [entry.filename.toLowerCase(), entry.slug]),
);

function docsFilePath(filename: string): string {
  return resolve(process.cwd(), '../../docs', filename);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/gi, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteHref(rawHref: string): { href: string; external: boolean } {
  if (!rawHref) return { href: '#', external: false };

  if (rawHref.startsWith('#')) {
    return { href: rawHref, external: false };
  }

  if (/^https?:\/\//i.test(rawHref) || rawHref.startsWith('mailto:')) {
    return { href: rawHref, external: true };
  }

  const hashIdx = rawHref.indexOf('#');
  const hash = hashIdx >= 0 ? rawHref.slice(hashIdx) : '';
  const pathPart = (hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref)
    .replace(/^\.\//, '')
    .replace(/^docs\//i, '');

  const normalized = pathPart.toLowerCase();
  if (normalized === 'privacy.md') {
    return { href: `${BASE_PATH}/privacy/${hash}`, external: false };
  }

  const docSlug = DOC_SLUG_BY_FILE.get(normalized);
  if (docSlug) {
    return { href: `${BASE_PATH}/docs/${docSlug}/${hash}`, external: false };
  }

  const cleanRepoPath = rawHref.replace(/^\.\//, '').replace(/^\//, '');
  return { href: `${REPO_URL}/blob/main/${cleanRepoPath}`, external: true };
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderMarkdownFile(
  filename: string,
  meta: { slug: string; title: string; summary: string; badge: string },
): RenderedDoc {
  const raw = readFileSync(docsFilePath(filename), 'utf8');
  const toc: TocItem[] = [];
  const usedIds = new Map<string, number>();
  let extractedTitle = meta.title;
  let strippedH1 = false;

  const baseRenderer = new Renderer();
  const renderer = new Renderer();

  renderer.heading = function ({ tokens, depth }: Tokens.Heading): string {
    const innerHtml = this.parser.parseInline(tokens);
    const plainText = decodeBasicEntities(innerHtml.replace(/<[^>]+>/g, '')).trim();

    if (depth === 1 && !strippedH1) {
      strippedH1 = true;
      extractedTitle = plainText || meta.title;
      return '';
    }

    const baseId = slugify(plainText) || `section-${toc.length + 1}`;
    const count = (usedIds.get(baseId) ?? 0) + 1;
    usedIds.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}-${count}`;

    if (depth === 2 || depth === 3) {
      toc.push({ id, text: plainText, level: depth });
    }

    return `<h${depth} id="${escapeAttr(id)}">${innerHtml}</h${depth}>\n`;
  };

  renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    const resolved = rewriteHref(href);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
    const relAttr = resolved.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeAttr(resolved.href)}"${titleAttr}${relAttr}>${text}</a>`;
  };

  renderer.table = function (token: Tokens.Table): string {
    const tableHtml = baseRenderer.table.call(this, token);
    return `<div class="table-wrap">${tableHtml}</div>\n`;
  };

  const parser = new Marked({ gfm: true, breaks: false, renderer });
  const html = parser.parse(raw) as string;

  return {
    slug: meta.slug,
    filename,
    title: extractedTitle,
    summary: meta.summary,
    badge: meta.badge,
    html,
    toc,
  };
}

export function getAllDocs(): DocEntry[] {
  return DOC_ENTRIES;
}

export function getDocBySlug(slug: string): RenderedDoc | null {
  const entry = DOC_ENTRIES.find((item) => item.slug === slug);
  if (!entry) return null;
  return renderMarkdownFile(entry.filename, entry);
}

export function getPrivacyDoc(): RenderedDoc {
  return renderMarkdownFile('PRIVACY.md', {
    slug: 'privacy',
    title: 'Glyphrig Privacy Policy',
    summary: 'Local-first privacy policy for the Glyphrig browser extension.',
    badge: 'Privacy Policy',
  });
}
