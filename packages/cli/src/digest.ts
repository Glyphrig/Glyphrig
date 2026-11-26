import path from 'node:path';
import {
  isSafeHttpUrl,
  normalizeUserList,
  parseBookmarkRepoFiles,
  type BookmarkEntry,
  type FolderNode,
} from '@glyphrig/core';
import { loadGlyphrigConfig } from './config.js';
import { readBookmarkDirectory } from './loader.js';

export type DigestFormat = 'markdown' | 'slack' | 'discord' | 'matrix' | 'json';

export const VALID_DIGEST_FORMATS: readonly DigestFormat[] = [
  'markdown',
  'slack',
  'discord',
  'matrix',
  'json',
];

export interface DigestBookmarkItem {
  title: string;
  url: string;
  normalizedUrl: string;
  folderPath: string;
  folderTitle: string;
  added?: string;
  note?: string;
  contributorNotes?: Record<string, string>;
  tags: string[];
  savedBy: string[];
}

export interface BookmarksDigestData {
  siteTitle: string;
  siteUrl?: string;
  days: number;
  sinceDate: string;
  generatedAt: string;
  totalBookmarks: number;
  recentBookmarks: DigestBookmarkItem[];
  popularBookmarks: DigestBookmarkItem[];
  topContributors: Array<{ username: string; count: number }>;
}

export interface GenerateDigestOptions {
  inputDir: string;
  configPath?: string;
  cwd?: string;
  days?: number;
  limit?: number;
  now?: Date;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function generateBookmarksDigest(
  options: GenerateDigestOptions,
): Promise<BookmarksDigestData> {
  const cwd = options.cwd ?? process.cwd();
  const inputDir = path.resolve(cwd, options.inputDir);
  const days = Math.max(1, options.days ?? 7);
  const limit = Math.max(1, options.limit ?? 15);
  const now = options.now ?? new Date();
  // Inclusive UTC window of `days` calendar days (e.g. days=7 covers today and the 6 preceding days)
  const since = new Date(now.getTime() - (days - 1) * 86_400_000);
  const sinceDate = since.toISOString().slice(0, 10);

  let siteTitle = 'Glyphrig Bookmarks';
  let siteUrl: string | undefined;
  try {
    const cfgRes = await loadGlyphrigConfig({ configPath: options.configPath, cwd });
    siteTitle = cfgRes.config.site.title;
    siteUrl = cfgRes.config.site.url;
  } catch {
    // Allow running without config file
  }

  const files = await readBookmarkDirectory(inputDir);
  const { tree } = parseBookmarkRepoFiles(files, 'bookmarks');

  const all: DigestBookmarkItem[] = [];
  function walk(folder: FolderNode): void {
    for (const bm of folder.bookmarks) {
      all.push({
        title: bm.title,
        url: bm.url,
        normalizedUrl: bm.normalizedUrl,
        folderPath: folder.path,
        folderTitle: folder.title,
        ...(bm.added && ISO_DATE_RE.test(bm.added) ? { added: bm.added } : {}),
        ...(bm.note ? { note: bm.note } : {}),
        ...(bm.contributorNotes ? { contributorNotes: bm.contributorNotes } : {}),
        tags: [...bm.tags],
        savedBy: normalizeUserList(bm.savedBy),
      });
    }
    for (const child of folder.children) {
      walk(child);
    }
  }
  walk(tree.root);

  const allRecent = all
    .filter((b) => Boolean(b.added && b.added >= sinceDate))
    .sort((a, b) => (b.added ?? '').localeCompare(a.added ?? '') || a.title.localeCompare(b.title));

  const recentBookmarks = allRecent.slice(0, limit);

  const popularMap = new Map<string, DigestBookmarkItem>();
  for (const item of all) {
    const prev = popularMap.get(item.normalizedUrl);
    if (!prev) {
      popularMap.set(item.normalizedUrl, { ...item, savedBy: [...item.savedBy] });
    } else {
      prev.savedBy = normalizeUserList([...prev.savedBy, ...item.savedBy]);
    }
  }

  const popularBookmarks = [...popularMap.values()]
    .filter((b) => b.savedBy.length >= 2)
    .sort(
      (a, b) =>
        b.savedBy.length - a.savedBy.length ||
        (b.added ?? '').localeCompare(a.added ?? '') ||
        a.title.localeCompare(b.title),
    )
    .slice(0, Math.min(limit, 10));

  const contributorUrls = new Map<string, Set<string>>();
  const sourceForContributors = allRecent.length > 0 ? allRecent : all;
  for (const item of sourceForContributors) {
    for (const u of item.savedBy) {
      const set = contributorUrls.get(u) ?? new Set<string>();
      set.add(item.normalizedUrl);
      contributorUrls.set(u, set);
    }
  }

  const topContributors = [...contributorUrls.entries()]
    .map(([username, urlSet]) => ({ username, count: urlSet.size }))
    .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username))
    .slice(0, 10);

  return {
    siteTitle,
    ...(siteUrl ? { siteUrl } : {}),
    days,
    sinceDate,
    generatedAt: now.toISOString(),
    totalBookmarks: all.length,
    recentBookmarks,
    popularBookmarks,
    topContributors,
  };
}

function summarizeItemNotes(item: DigestBookmarkItem): string {
  const parts: string[] = [];
  if (item.note) parts.push(item.note);
  if (item.contributorNotes) {
    for (const [u, text] of Object.entries(item.contributorNotes)) {
      parts.push(`@${u}: ${text}`);
    }
  }
  return parts.join(' · ');
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeSlackText(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeSlackLabel(raw: string): string {
  return escapeSlackText(raw).replace(/\|/g, '｜');
}

function escapeMarkdownLink(title: string, url: string): string {
  const safeTitle = title.replace(/[\r\n]+/g, ' ').replace(/([\\[\]])/g, '\\$1');
  const safeUrl = url.replace(/\)/g, '%29').replace(/\s/g, '%20');
  return `[${safeTitle}](${safeUrl})`;
}

function joinLinesWithinLimit(lines: string[], maxChars: number): string {
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    const addLen = (out.length > 0 ? 1 : 0) + line.length;
    if (len + addLen > maxChars) break;
    out.push(line);
    len += addLen;
  }
  return out.join('\n');
}

export function formatBookmarksDigest(
  data: BookmarksDigestData,
  format: DigestFormat,
): string {
  if (!VALID_DIGEST_FORMATS.includes(format)) {
    throw new Error(
      `Invalid digest format "${format}". Expected one of: ${VALID_DIGEST_FORMATS.join(', ')}.`,
    );
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  const heading = `${data.siteTitle} — Last ${data.days} Day${data.days === 1 ? '' : 's'} Digest`;

  if (format === 'markdown') {
    const lines: string[] = [`# ${heading}`, ''];
    if (data.siteUrl && isSafeHttpUrl(data.siteUrl)) {
      lines.push(`Browse full garden: ${data.siteUrl}`, '');
    }
    lines.push(
      `**${data.recentBookmarks.length}** new bookmark${data.recentBookmarks.length === 1 ? '' : 's'} since ${data.sinceDate} (${data.totalBookmarks} total).`,
      '',
    );

    if (data.recentBookmarks.length > 0) {
      lines.push('## New Links');
      for (const bm of data.recentBookmarks) {
        const who = bm.savedBy.length > 0 ? ` (${bm.savedBy.map((u) => `@${u}`).join(', ')})` : '';
        const note = summarizeItemNotes(bm);
        lines.push(
          `- ${escapeMarkdownLink(bm.title, bm.url)} in *${bm.folderTitle}*${who}${note ? ` — ${note}` : ''}`,
        );
      }
      lines.push('');
    }

    if (data.popularBookmarks.length > 0) {
      lines.push('## Most Saved by Team');
      for (const bm of data.popularBookmarks) {
        lines.push(`- ★ ${bm.savedBy.length} — ${escapeMarkdownLink(bm.title, bm.url)}`);
      }
      lines.push('');
    }

    if (data.topContributors.length > 0) {
      lines.push(
        `## Contributors`,
        data.topContributors.map((c) => `- **@${c.username}** (${c.count})`).join('\n'),
      );
    }

    return lines.join('\n').trim() + '\n';
  }

  if (format === 'slack') {
    const safeSiteLink =
      data.siteUrl && isSafeHttpUrl(data.siteUrl)
        ? ` <${escapeSlackText(data.siteUrl)}|Open garden>`
        : '';
    const blocks: unknown[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: heading.slice(0, 150) },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${data.recentBookmarks.length}* new link(s) since ${data.sinceDate} (${data.totalBookmarks} total).${safeSiteLink}`,
        },
      },
    ];

    if (data.recentBookmarks.length > 0) {
      const linkLines = data.recentBookmarks.slice(0, 10).map((bm) => {
        const note = summarizeItemNotes(bm);
        const who = bm.savedBy.length
          ? ` _(${bm.savedBy.map((u) => `@${escapeSlackText(u)}`).join(', ')})_`
          : '';
        return `• <${escapeSlackText(bm.url)}|${escapeSlackLabel(bm.title)}>${who}${note ? ` — ${escapeSlackText(note)}` : ''}`;
      });
      const listText = joinLinesWithinLimit(linkLines, 2900);
      if (listText) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*New Links*\n${listText}` },
        });
      }
    }

    if (data.popularBookmarks.length > 0) {
      const popLines = data.popularBookmarks
        .slice(0, 5)
        .map((bm) => `★ ${bm.savedBy.length} • <${escapeSlackText(bm.url)}|${escapeSlackLabel(bm.title)}>`);
      const popText = joinLinesWithinLimit(popLines, 2900);
      if (popText) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*Most Saved*\n${popText}` },
        });
      }
    }

    return JSON.stringify({ text: heading, blocks }, null, 2);
  }

  if (format === 'discord') {
    const fields: Array<{ name: string; value: string }> = [];
    if (data.recentBookmarks.length > 0) {
      const value = joinLinesWithinLimit(
        data.recentBookmarks
          .slice(0, 8)
          .map((bm) => `• ${escapeMarkdownLink(bm.title, bm.url)}`),
        1000,
      );
      if (value) {
        fields.push({ name: `New Links (${data.recentBookmarks.length})`, value });
      }
    }
    if (data.popularBookmarks.length > 0) {
      const value = joinLinesWithinLimit(
        data.popularBookmarks
          .slice(0, 5)
          .map((bm) => `★ ${bm.savedBy.length} ${escapeMarkdownLink(bm.title, bm.url)}`),
        1000,
      );
      if (value) {
        fields.push({ name: 'Most Saved', value });
      }
    }
    return JSON.stringify(
      {
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: heading.slice(0, 256),
            ...(data.siteUrl && isSafeHttpUrl(data.siteUrl) ? { url: data.siteUrl } : {}),
            description: `${data.recentBookmarks.length} new link(s) since ${data.sinceDate} (${data.totalBookmarks} total).`,
            color: 0xb45309,
            fields,
          },
        ],
      },
      null,
      2,
    );
  }

  // Matrix message payload (m.room.message)
  const plain = formatBookmarksDigest(data, 'markdown');
  const htmlItems = data.recentBookmarks
    .filter((bm) => isSafeHttpUrl(bm.url))
    .map((bm) => {
      const note = summarizeItemNotes(bm);
      return `<li><a href="${escapeHtml(bm.url)}">${escapeHtml(bm.title)}</a>${note ? ` — ${escapeHtml(note)}` : ''}</li>`;
    })
    .join('');
  const formattedBody = htmlItems
    ? `<h3>${escapeHtml(heading)}</h3><ul>${htmlItems}</ul>`
    : `<h3>${escapeHtml(heading)}</h3><p>No new bookmarks since ${escapeHtml(data.sinceDate)}.</p>`;
  return JSON.stringify(
    {
      msgtype: 'm.notice',
      body: plain,
      format: 'org.matrix.custom.html',
      formatted_body: formattedBody,
    },
    null,
    2,
  );
}

export async function postDigestWebhook(
  webhookUrl: string,
  format: DigestFormat,
  body: string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  if (!isSafeHttpUrl(webhookUrl)) {
    throw new Error('Digest webhook URL must be a valid http:// or https:// URL.');
  }
  const isJson = format !== 'markdown';
  const res = await fetchFn(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) {
    throw new Error(`Digest webhook failed with HTTP ${res.status}`);
  }
}

export type _UnusedBookmarkEntryRef = BookmarkEntry;
