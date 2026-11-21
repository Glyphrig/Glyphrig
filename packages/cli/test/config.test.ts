import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inferBasePath, loadGlyphrigConfig } from '../src/config.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glyphrig-cfg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('config loader & base path inference', () => {
  it('returns sensible defaults when no glyphrig.config.yaml is present', async () => {
    const dir = await makeTempDir();
    const res = await loadGlyphrigConfig({ cwd: dir, env: {} });
    expect(res.configFound).toBe(false);
    expect(res.config.site.title).toBe('Glyphrig Bookmarks');
    expect(res.config.site.base).toBe('/');
    expect(res.config.theme.defaultView).toBe('list');
    expect(res.config.enrichment.enabled).toBe(true);
  });

  it('infers GitHub Pages project subpath when running in GitHub Actions without CNAME', async () => {
    const dir = await makeTempDir();
    const base = await inferBasePath(dir, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'alice/my-links',
    });
    expect(base).toBe('/my-links/');

    // User/org root site stays '/'
    const rootSiteBase = await inferBasePath(dir, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'alice/alice.github.io',
    });
    expect(rootSiteBase).toBe('/');

    // Custom domain CNAME overrides subpath inference to '/'
    await fs.writeFile(path.join(dir, 'CNAME'), 'links.example.com\n', 'utf8');
    const cnameBase = await inferBasePath(dir, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'alice/my-links',
    });
    expect(cnameBase).toBe('/');
  });

  it('validates custom YAML config and lets CLI --base take precedence', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'glyphrig.config.yaml'),
      [
        'site:',
        '  title: My Digital Garden',
        '  base: /bookmarks',
        'theme:',
        '  accent: "#1d4ed8"',
        '  defaultView: cards',
        'pwa:',
        '  enabled: true',
        '  quickAdd:',
        '    enabled: true',
        '    forge: github',
        '    owner: alice',
        '    repo: links',
      ].join('\n'),
      'utf8',
    );

    const fromFile = await loadGlyphrigConfig({ cwd: dir, env: {} });
    expect(fromFile.configFound).toBe(true);
    expect(fromFile.config.site.title).toBe('My Digital Garden');
    expect(fromFile.config.site.base).toBe('/bookmarks/');
    expect(fromFile.config.theme.defaultView).toBe('cards');
    expect(fromFile.config.pwa.quickAdd.enabled).toBe(true);

    const withCliOverride = await loadGlyphrigConfig({
      cwd: dir,
      cliBase: '/custom-override',
      env: {},
    });
    expect(withCliOverride.config.site.base).toBe('/custom-override/');
  });
});
