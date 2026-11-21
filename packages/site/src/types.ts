import type { BookmarkEntry, ForgeKind } from '@glyphrig/core';

export interface SiteConfig {
  site: {
    title: string;
    description: string;
    author: string;
    url?: string;
    base: string;
  };
  theme: {
    accent: string;
    defaultView: 'list' | 'cards';
    customCss?: string;
  };
  enrichment: {
    enabled: boolean;
    fetchFavicons: boolean;
    fetchOgImage: boolean;
    autoTags: boolean;
    concurrency: number;
    timeoutMs: number;
    ttlDays: number;
  };
  pwa: {
    enabled: boolean;
    quickAdd: {
      enabled: boolean;
      forge: ForgeKind;
      instanceUrl?: string;
      owner: string;
      repo: string;
      branch: string;
      rootDir: string;
    };
  };
}

export interface EnrichedBookmark extends BookmarkEntry {
  id: string;
  domain: string;
  folderPath: string;
  folderTitle: string;
  folderSegments: Array<{ title: string; path: string }>;
  effectiveDescription?: string;
  ogImage?: string;
  faviconPath?: string;
  scrapedTitle?: string;
  savedBy: string[];
  globalSavedBy: string[];
  popularity: number;
}

export interface ContributorSummary {
  username: string;
  slug: string;
  count: number;
}

export interface EnrichedFolderNode {
  path: string;
  slug: string;
  title: string;
  order: number;
  description?: string;
  introMarkdown?: string;
  introHtml?: string;
  bookmarks: EnrichedBookmark[];
  children: EnrichedFolderNode[];
  totalBookmarkCount: number;
}

export interface TagSummary {
  tag: string;
  slug: string;
  count: number;
}

export interface GlyphrigSiteData {
  config: SiteConfig;
  root: EnrichedFolderNode;
  flatFolders: EnrichedFolderNode[];
  allBookmarks: EnrichedBookmark[];
  tags: TagSummary[];
  contributors: ContributorSummary[];
  customCssContent?: string;
  hasCustomFaviconAsset: boolean;
  generatedAt: string;
}
