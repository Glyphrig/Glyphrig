/// <reference types="astro/client" />

declare module 'virtual:glyphrig-data' {
  import type { GlyphrigSiteData } from './types.js';
  export const siteData: GlyphrigSiteData;
}
