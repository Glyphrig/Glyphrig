/// <reference types="astro/client" />

declare module 'virtual:glyphrig-data' {
  import type { GlyphrigSiteData } from './types.js';
  export const siteData: GlyphrigSiteData;
}

declare module 'virtual:glyphrig-theme.css';

declare module 'virtual:glyphrig-helpers' {
  export * from './lib/data.js';
}
