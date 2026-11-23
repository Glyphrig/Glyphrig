import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const publicDir = resolve(appRoot, 'public');
const privacySrc = resolve(appRoot, '../../docs/PRIVACY.md');
const privacyDest = resolve(publicDir, 'PRIVACY.md');
const nojekyllPath = resolve(publicDir, '.nojekyll');

mkdirSync(publicDir, { recursive: true });
copyFileSync(privacySrc, privacyDest);
writeFileSync(nojekyllPath, '', 'utf8');
