import { fileURLToPath } from 'node:url';

export const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export type * from './types.js';
