import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSite } from '../src/astro-runner.js';
import { loadGlyphrigConfig } from '../src/config.js';
import { initBookmarkRepo } from '../src/init.js';
import { validateBookmarksRepo } from '../src/loader.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glyphrig-init-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('glyphrig init scaffolder', () => {
  it('scaffolds default github repo that validates and builds end-to-end with Astro + Pagefind', async () => {
    const repoDir = await makeTempDir();
    const res = await initBookmarkRepo({
      targetDir: repoDir,
      title: 'Personal Links: 2026',
      author: 'Alice',
    });

    expect(res.ci).toBe('github');
    expect(res.created).toContain('.github/workflows/deploy.yml');
    expect(res.created).toContain('glyphrig.config.yaml');
    expect(res.created).toContain('bookmarks/README.md');
    expect(res.created).toContain('bookmarks/dev/web/README.md');
    expect(res.skipped).toHaveLength(0);

    const report = await validateBookmarksRepo({
      inputDir: path.join(repoDir, 'bookmarks'),
      cwd: repoDir,
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.bookmarkCount).toBe(8);
    expect(report.folderCount).toBe(4);

    const cfg = await loadGlyphrigConfig({ cwd: repoDir, env: {} });
    expect(cfg.config.site.title).toBe('Personal Links: 2026');
    expect(cfg.config.site.author).toBe('Alice');

    const outDir = path.join(repoDir, 'dist');
    const built = await buildSite({
      cwd: repoDir,
      inputDir: 'bookmarks',
      outDir,
      cacheDir: path.join(repoDir, '.glyphrig-cache'),
      base: '/my-links/',
      noEnrich: true,
    });
    expect(built.bookmarkCount).toBe(8);

    for (const rel of [
      'index.html',
      'f/dev/web/index.html',
      'rss.xml',
      'feed.json',
      'manifest.webmanifest',
      'sw.js',
      'pagefind/pagefind.js',
    ]) {
      const stat = await fs.stat(path.join(outDir, rel));
      expect(stat.isFile(), `Expected ${rel} to exist`).toBe(true);
    }
  }, 30000);

  it('supports gitlab, forgejo, cloudflare, all CI templates, --no-examples, and quickAdd', async () => {
    const gitlabDir = await makeTempDir();
    const gl = await initBookmarkRepo({
      targetDir: gitlabDir,
      ci: 'gitlab',
      examples: false,
      quickAdd: {
        enabled: true,
        forge: 'gitlab',
        owner: 'alice',
        repo: 'glyphrig_bookmarks',
      },
    });
    expect(gl.created).toContain('.gitlab-ci.yml');
    expect(gl.created).not.toContain('.github/workflows/deploy.yml');
    expect(gl.created).not.toContain('bookmarks/dev/README.md');

    const glCfg = await loadGlyphrigConfig({ cwd: gitlabDir, env: {} });
    expect(glCfg.config.pwa.quickAdd.enabled).toBe(true);
    expect(glCfg.config.pwa.quickAdd.forge).toBe('gitlab');
    expect(glCfg.config.pwa.quickAdd.owner).toBe('alice');

    const forgejoDir = await makeTempDir();
    const fj = await initBookmarkRepo({ targetDir: forgejoDir, ci: 'forgejo' });
    expect(fj.created).toContain('.forgejo/workflows/deploy.yml');

    const cfDir = await makeTempDir();
    const cf = await initBookmarkRepo({ targetDir: cfDir, ci: 'cloudflare' });
    expect(cf.created).not.toContain('.github/workflows/deploy.yml');
    const cfReadme = await fs.readFile(path.join(cfDir, 'README.md'), 'utf8');
    expect(cfReadme).toContain('Cloudflare Pages');

    const allDir = await makeTempDir();
    const allRes = await initBookmarkRepo({ targetDir: allDir, ci: 'all' });
    expect(allRes.created).toContain('.github/workflows/deploy.yml');
    expect(allRes.created).toContain('ci-templates/gitlab-ci.yml');
    expect(allRes.created).toContain('ci-templates/forgejo-deploy.yml');
    expect(allRes.created).toContain('ci-templates/hosting-providers.md');
  });

  it('skips existing files unless force is true', async () => {
    const dir = await makeTempDir();
    await initBookmarkRepo({ targetDir: dir, title: 'First' });

    const configPath = path.join(dir, 'glyphrig.config.yaml');
    await fs.writeFile(configPath, 'site:\n  title: Custom User Edit\n', 'utf8');

    const second = await initBookmarkRepo({ targetDir: dir, title: 'Second' });
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toContain('glyphrig.config.yaml');
    expect(await fs.readFile(configPath, 'utf8')).toContain('Custom User Edit');

    const forced = await initBookmarkRepo({ targetDir: dir, title: 'Forced', force: true });
    expect(forced.created).toContain('glyphrig.config.yaml');
    expect(await fs.readFile(configPath, 'utf8')).toContain('Forced');
  });

  it('runs non-interactively via CLI binary with --yes', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'my-bookmarks');
    const cliBin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

    const { stdout } = await execFileAsync(process.execPath, [
      cliBin,
      'init',
      target,
      '--yes',
      '--ci',
      'github',
      '--title',
      'CLI Scaffolded',
    ]);

    expect(stdout).toContain('Initialized Glyphrig bookmark repository');
    const cfg = await loadGlyphrigConfig({ cwd: target, env: {} });
    expect(cfg.config.site.title).toBe('CLI Scaffolded');
  });
});
